'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {GraphManager,compileGraph,FORMAT}=require('../lib/graph-manager');
const {fromLiveState}=require('../lib/universal-graph');
const {scanProject}=require('../lib/live');

function graph(revision='r1',kind='number'){
  return {
    format:FORMAT,namespace:'tinner-ci',revision,root:'root',
    definitions:[{id:'worker',version:1,kind:'handler',
      inputs:[{name:'input',type:kind}],outputs:[{name:'output',type:kind}]}],
    graphs:[
      {id:'root',inputs:[],outputs:[],nodes:[
        {id:'top',definition:'worker@1'},
        {id:'nested',graphRef:'child'}],connections:[]},
      {id:'child',inputs:[],outputs:[],nodes:[
        {id:'inside',definition:'worker@1'}],connections:[]}
    ],
    dependencies:[],
    exports:[{path:'top',input:'input',output:'output'},
      {path:'nested/inside',input:'input',output:'output'}]
  };
}
const handlers=fn=>new Map([['worker@1',fn]]);
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-graph-manager-'));
  const source=path.join(root,'source'),state=path.join(root,'live');
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(source,'scenes'),{recursive:true});
  fs.writeFileSync(path.join(source,'project.godot'),'[application]\nconfig/name="Graph Manager"\n');
  fs.writeFileSync(path.join(source,'scripts','main.gd'),
    'extends Node\nconst NEXT = preload("res://scenes/scene.tscn")\n');
  fs.writeFileSync(path.join(source,'scenes','scene.tscn'),
    '[gd_scene format=3]\n[node name="Main" type="Node"]\n');
  return {root,source,state};
}
const cleanup=f=>fs.rmSync(f.root,{recursive:true,force:true});

test('staging and switching trusted handlers never execute code before invoke',async()=>{
  let invoked=0;
  const manager=new GraphManager();
  assert.equal(manager.stage(graph(),handlers(x=>{invoked++;return x+1})).status,'staged');
  assert.equal(invoked,0);
  assert.equal(manager.status().active,null);
  assert.throws(()=>manager.activate('r1'),/expectedActive/);
  assert.equal(manager.activate('r1',{expectedActive:null}).revision,'r1');
  assert.equal(await manager.invoke('nested/inside',3),4);
  assert.equal(invoked,1);
});

test('in-flight invocation uses its own generation across atomic swap and rollback',async()=>{
  const manager=new GraphManager();
  let release;
  manager.stage(graph('r1'),handlers(async x=>{
    await new Promise(resolve=>{release=resolve});return x+1;
  }));
  manager.activate('r1',{expectedActive:null});
  const pending=manager.invoke('nested/inside',5);
  assert.equal(manager.status().inflight.r1,1);
  manager.stage(graph('r2'),handlers(x=>x+100));
  const switched=manager.activate('r2',{expectedActive:'r1'});
  assert.equal(switched.oldInflight,1);
  assert.equal(await manager.invoke('nested/inside',5),105);
  release();
  assert.equal(await pending,6);
  assert.deepEqual(manager.status().inflight,{});
  assert.throws(()=>manager.rollback({expectedActive:'r1'}),/exact active/);
  assert.equal(manager.rollback({expectedActive:'r2'}).revision,'r1');
});

test('revision CAS, namespace scope, and exported port compatibility are enforced',()=>{
  const manager=new GraphManager();
  manager.stage(graph('r1'),handlers(x=>x));
  manager.activate('r1',{expectedActive:null});
  manager.stage(graph('r2'),handlers(x=>x+1));
  assert.throws(()=>manager.activate('r2',{expectedActive:null}),/conflict/);
  const breaking=graph('r3','string');
  manager.stage(breaking,handlers(x=>x));
  assert.throws(()=>manager.activate('r3',{expectedActive:'r1'}),/Breaking public port contracts/);
  assert.equal(manager.activate('r3',{expectedActive:'r1',allowBreaking:true}).revision,'r3');
  const unrelated=graph('other');unrelated.namespace='another';
  manager.stage(unrelated,handlers(x=>x));
  assert.throws(()=>manager.activate('other',{expectedActive:'r3'}),/namespace mismatch/);
});

test('typed edges validate compatible ports and allow scoped declared invocation',async()=>{
  const ir=graph();
  ir.graphs[0].nodes=[{id:'top',definition:'worker@1'},{id:'other',definition:'worker@1'},
    {id:'nested',graphRef:'child'}];
  ir.graphs[0].connections=[{from:{node:'top',port:'output'},to:{node:'other',port:'input'}}];
  const manager=new GraphManager();
  let calls=0;
  manager.stage(ir,handlers(async(x,ctx)=>{
    calls++;
    if(ctx.nodeId==='top')return ctx.invoke('other',x+1);
    return x*2;
  }));
  manager.activate('r1',{expectedActive:null});
  assert.equal(await manager.invoke('top',7),16);
  assert.equal(calls,2);
  const bad=graph('bad');
  bad.definitions.push({id:'string-work',version:1,kind:'handler',
    inputs:[{name:'input',type:'string'}],outputs:[{name:'output',type:'string'}]});
  bad.graphs[0].nodes.push({id:'other',definition:'string-work@1'});
  bad.graphs[0].connections=[{from:{node:'top',port:'output'},to:{node:'other',port:'input'}}];
  assert.throws(()=>compileGraph(bad,new Map([...handlers(x=>x),['string-work@1',x=>x]])),
    /incompatible typed port/);
});

test('unlisted dependencies, recursive graphs, cycles and missing handlers fail closed',async()=>{
  const manager=new GraphManager();
  const recursive=graph();
  recursive.graphs[1].nodes.push({id:'recursive',graphRef:'root'});
  assert.throws(()=>manager.stage(recursive,handlers(x=>x)),/Recursive nested graph/);
  const unknown=graph();unknown.dependencies=[{from:'missing',to:'top'}];
  assert.throws(()=>manager.stage(unknown,handlers(x=>x)),/Unresolved reference dependency/);
  const cycle=graph();cycle.graphs[0].nodes.push({id:'other',definition:'worker@1'});
  cycle.graphs[0].connections=[
    {from:{node:'top',port:'output'},to:{node:'other',port:'input'}},
    {from:{node:'other',port:'output'},to:{node:'top',port:'input'}}
  ];
  assert.throws(()=>manager.stage(cycle,handlers(x=>x)),/Cyclic executable connection/);
  assert.throws(()=>manager.stage(graph()),/Trusted handler is missing/);
  manager.stage(graph(),handlers(x=>x));
  manager.activate('r1',{expectedActive:null});
  await assert.rejects(()=>manager.invoke('top','wrong type'),/Invalid typed input/);
  await assert.rejects(()=>manager.invoke('top',3,{output:'missing'}),/Public graph entry port contract mismatch/);
  await assert.rejects(()=>manager.invoke('nested',3),/not executable/);
});

test('handler may invoke only declared graph edges, and output type is checked',async()=>{
  const manager=new GraphManager();
  manager.stage(graph(),handlers(async(x,ctx)=>ctx.invoke('inside',x)));
  manager.activate('r1',{expectedActive:null});
  await assert.rejects(()=>manager.invoke('top',2),/Undeclared graph dependency/);
  const output=new GraphManager();
  output.stage(graph(),handlers(x=>String(x)));
  output.activate('r1',{expectedActive:null});
  await assert.rejects(()=>output.invoke('top',2),/Invalid typed output/);
});

test('same revision cannot be reused to silently replace a staged immutable graph',()=>{
  const manager=new GraphManager();
  const fn=x=>x;
  manager.stage(graph(),handlers(fn));
  assert.equal(manager.stage(graph(),handlers(fn)).status,'already-staged');
  assert.throws(()=>manager.stage(graph(),handlers(x=>x)),/different trusted handler bindings/);
  const changed=graph();changed.graphs[0].nodes[0].label='different';
  assert.throws(()=>manager.stage(changed,handlers(x=>x)),/different graph content/);
});

test('Tinner accepted revision produces nested deterministic reference graph with dependencies',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.source,f.state);
    const ir=fromLiveState(f.state);
    assert.equal(ir.format,FORMAT);
    assert.equal(ir.revision,first.revision);
    assert.equal(ir.graphs.length,3);
    assert.equal(ir.source.files,3);
    assert.equal(ir.dependencies.length,1);
    assert.ok(ir.definitions.every(d=>d.kind==='reference'));
    assert.deepEqual(ir,fromLiveState(f.state));
    const manager=new GraphManager();
    assert.equal(manager.stage(ir).status,'staged');
    manager.activate(ir.revision,{expectedActive:null});
    const root=ir.graphs.find(g=>g.id===ir.root);
    const nested=root.nodes.find(n=>n.graphRef===ir.graphs.find(g=>g.nodes.some(n=>n.source?.path==='scripts/main.gd')).id);
    assert.ok(nested);
    assert.equal(manager.status().active,first.revision);
  }finally{cleanup(f);}
});

test('file content edits retain stable IDs while changing the accepted IR revision',()=>{
  const f=fixture();
  try{
    scanProject(f.source,f.state);
    const one=fromLiveState(f.state);
    fs.appendFileSync(path.join(f.source,'scripts','main.gd'),'func x():\n    pass\n');
    scanProject(f.source,f.state);
    const two=fromLiveState(f.state);
    assert.notEqual(one.revision,two.revision);
    const nodes=ir=>ir.graphs.flatMap(g=>g.nodes).filter(n=>n.source);
    const oldNodes=nodes(one),newNodes=nodes(two);
    assert.deepEqual(oldNodes.map(n=>n.id),newNodes.map(n=>n.id));
    assert.notEqual(oldNodes.find(n=>n.source.path==='scripts/main.gd').source.sha256,
      newNodes.find(n=>n.source.path==='scripts/main.gd').source.sha256);
  }finally{cleanup(f);}
});

test('CLI graph-ir exports immutable private JSON from accepted live revision',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.source,f.state);
    const target=path.join(f.root,'graph.json');
    const binary=path.join(__dirname,'../bin/tinner.js');
    const result=spawnSync(process.execPath,[binary,'graph-ir',f.state,target],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const parsed=JSON.parse(fs.readFileSync(target,'utf8'));
    assert.equal(parsed.revision,first.revision);
    assert.equal(compileGraph(parsed).nodes.size,5);
    assert.equal(spawnSync(process.execPath,[binary,'graph-ir',f.state,target]).status,1);
    if(process.platform!=='win32')assert.equal(fs.statSync(target).mode&0o777,0o600);
  }finally{cleanup(f);}
});


test('unexported internal node is only callable via its declared local connection',async()=>{
  const ir=graph();
  ir.graphs[0].nodes.push({id:'internal',definition:'worker@1'});
  ir.graphs[0].connections.push({
    from:{node:'top',port:'output'},to:{node:'internal',port:'input'}
  });
  const manager=new GraphManager();
  manager.stage(ir,handlers((x,{nodeId,invoke})=>
    nodeId==='top'?invoke('internal',x+1):x*3
  ));
  manager.activate('r1',{expectedActive:null});
  assert.equal(await manager.invoke('top',2),9);
  await assert.rejects(()=>manager.invoke('internal',2),/not publicly exported/);
});
