'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {mask,indexSourceSymbols,buildSymbolGraph,buildSymbolFlow}=require('../lib/symbols');
const {exportProject,verifyProject,restoreProject}=require('../lib/project');

test('GDScript: typed function ports and direct-call edges, no source execution',()=>{
  const source=[
    'extends Node',
    'var message = """',
    'func phantom(x: String):',
    '    do_not_parse()',
    '"""',
    '# func commented(x: int):',
    'func move(distance: float, direction: Vector2) -> bool:',
    '    if distance > 0:',
    '        return normalize(direction)',
    '    return false',
    '',
    'func normalize(value: Vector2) -> bool:',
    '    return true',
    '',
    'static func utility(value = "literal") -> void:',
    '    print("func fake(x):")',
    ''
  ].join('\n');
  const found=indexSourceSymbols(source,'scripts/player.gd');
  assert.equal(found.language,'gdscript');
  assert.deepEqual(found.symbols.map(s=>s.name),['move','normalize','utility']);
  assert.deepEqual(found.symbols[0].inputs,[
    {name:'distance',type:'float',explicit:true},
    {name:'direction',type:'Vector2',explicit:true}
  ]);
  assert.deepEqual(found.symbols[0].outputs,[{name:'return',type:'bool',explicit:true}]);
  assert.deepEqual(found.symbols[2].outputs,[]);
  assert.deepEqual(found.symbols[2].inputs,[{name:'value',type:'Variant',explicit:false}]);
  assert.ok(found.symbols[0].lineStart<found.symbols[1].lineStart);
  const graph=buildSymbolGraph([{file:'scripts/player.gd',...found}]);
  assert.equal(graph.edges.length,1);
  assert.equal(graph.edges[0].from,found.symbols[0].id);
  assert.equal(graph.edges[0].to,found.symbols[1].id);
  assert.equal(graph.edges[0].confidence,'heuristic');
  const flow=buildSymbolFlow(graph,'scripts/player.gd');
  const move=flow.find(n=>n.type==='tinner-symbol'&&n.name==='move');
  const normalize=flow.find(n=>n.type==='tinner-symbol'&&n.name==='normalize');
  assert.deepEqual(move.wires,[[normalize.id]]);
  assert.equal(JSON.parse(move.ports).inputs.length,2);
  assert.equal(globalThis.__TINNER_EXECUTED__,undefined);
});
test('GDScript: ignores commented/multiline triple quoted false declarations',()=>{
  const data='""" \nfunc bogus():\n    pass\n"""\n# func nope():\nfunc real():\n    pass\n';
  assert.deepEqual(indexSourceSymbols(data,'foo.gd').symbols.map(x=>x.name),['real']);
  const shadow=mask(data,'gdscript');
  assert.equal(shadow.includes('bogus'),false);
  assert.equal(shadow.includes('real'),true);
});
test('C++: conservative method-definition index and call graph',()=>{
  const code=[
    '#include "header.h"',
    'const char* misleading = "void Fake::doit() {}";',
    '// void Fake::ignored() {}',
    'void Worker::run(int count, float dt) {',
    '  update(count);',
    '}',
    'bool Worker::update(int count) {',
    '  return count > 0;',
    '}',
    'int Worker::only_declaration(int x);',
    ''
  ].join('\n');
  const indexed=indexSourceSymbols(code,'scene/worker.cpp');
  assert.deepEqual(indexed.symbols.map(s=>s.name),['Worker::run','Worker::update']);
  assert.equal(indexed.status,'heuristic');
  assert.equal(indexed.symbols[0].inputs[0].name,'count');
  assert.equal(indexed.symbols[0].inputs[0].type,'int');
  assert.equal(indexed.symbols[0].outputs.length,0);
  const graph=buildSymbolGraph([{file:'scene/worker.cpp',...indexed}]);
  assert.equal(graph.edges.length,1);
  assert.equal(graph.edges[0].to,indexed.symbols[1].id);
});
test('Source symbols use unique stable node IDs and do not link ambiguous names',()=>{
  const first=indexSourceSymbols('func ping():\n    pong()\nfunc pong():\n    pass\n','a.gd');
  const second=indexSourceSymbols('func pong():\n    pass\n','b.gd');
  const graph=buildSymbolGraph([{file:'a.gd',...first},{file:'b.gd',...second}]);
  assert.equal(graph.edges.length,1);
  assert.notEqual(first.symbols[1].id,second.symbols[0].id);
  assert.equal(first.symbols[0].id,indexSourceSymbols('func ping():\n    pong()\nfunc pong():\n    pass\n','a.gd').symbols[0].id);
});
test('Godot project export auto-generates verified typed symbol flows; restore unchanged',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-sym-'));
  try{
    const src=path.join(root,'src'),bundle=path.join(root,'bundle'),dst=path.join(root,'restored');
    fs.mkdirSync(path.join(src,'scripts'),{recursive:true});
    fs.writeFileSync(path.join(src,'project.godot'),'[application]\nconfig/name="test"\n');
    const gd='extends Node\nfunc load(name: String) -> int:\n    return calc(3)\nfunc calc(n: int) -> int:\n    return n+1\n';
    fs.writeFileSync(path.join(src,'scripts','a.gd'),gd);
    const result=exportProject(src,bundle);
    assert.equal(result.manifest.symbolIndex.functions,2);
    assert.equal(result.manifest.symbolIndex.possibleCallEdges,1);
    assert.equal(verifyProject(bundle).verified,2);
    const symbols=JSON.parse(fs.readFileSync(path.join(bundle,'symbol-graph.json'),'utf8'));
    assert.equal(symbols.symbols.length,2);
    const flow=JSON.parse(fs.readFileSync(path.join(bundle,'flows','symbols','scripts','a.gd.json'),'utf8'));
    assert.equal(flow.filter(x=>x.type==='tinner-symbol').length,2);
    assert.ok(result.manifest.generatedArtifacts.some(x=>x.path==='symbol-graph.json'));
    assert.equal(restoreProject(bundle,dst).restored,2);
    assert.equal(fs.readFileSync(path.join(dst,'scripts','a.gd'),'utf8'),gd);
    const corrupt=path.join(bundle,'flows','symbols','scripts','a.gd.json');
    fs.appendFileSync(corrupt,' ');
    assert.throws(()=>verifyProject(bundle),/Generated graph integrity mismatch/i);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Palette symbol nodes are inert even for cyclic reference graph',()=>{
  const constructors={};
  const RED={nodes:{
    createNode(n){n.on=(name,fn)=>{n[name]=fn;};},
    registerType(name,ctor){constructors[name]=ctor;}
  }};
  require('../nodes/tinner')(RED);
  assert.equal(typeof constructors['tinner-symbol'],'function');
  const node=new constructors['tinner-symbol']({name:'hello'});
  let transmitted=0,done=0;
  node.input({payload:'should never execute or forward'},()=>transmitted++,()=>done++);
  assert.equal(transmitted,0);
  assert.equal(done,1);
});
