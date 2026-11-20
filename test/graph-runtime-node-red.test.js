'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {GraphRuntime}=require('../lib/graph-runtime');
const {catalog}=require('../lib/graph-catalog');
const register=require('../nodes/tinner-graph');

function ir(revision='r1',offset=5){
  return {
    format:'mechanicus.universal-graph/1',namespace:'node-red-test',
    revision,root:'root',
    definitions:[{
      id:'mechanicus.math.offset',version:1,kind:'handler',
      inputs:[{name:'input',type:'number'}],
      outputs:[{name:'output',type:'number'}]
    }],
    graphs:[{id:'root',nodes:[
      {id:'container',graphRef:'inside'}
    ],inputs:[],outputs:[],connections:[]},
    {id:'inside',nodes:[{id:'worker',
      definition:'mechanicus.math.offset@1',params:{offset}}],
      inputs:[],outputs:[],connections:[]}],
    dependencies:[],
    exports:[{path:'container/worker',input:'input',output:'output'}]
  };
}
function registry({auth=true}={}){
  const registered=new Map(),routes=new Map(),permissions=[];
  const RED={
    nodes:{
      registerType:(name,constructor)=>registered.set(name,constructor),
      createNode:(node,config)=>{
        node.id=config.id||'graph-one';
        node._events={};
        node._sent=[];
        node._errors=[];
        node._status=null;
        node.on=(event,handler)=>{node._events[event]=handler;};
        node.status=status=>{node._status=status;};
        node.send=msg=>{node._sent.push(msg);};
        node.error=err=>{node._errors.push(err);};
      }
    },
    httpAdmin:{
      get:(path,middleware,handler)=>routes.set('GET '+path,{middleware,handler}),
      post:(path,middleware,handler)=>routes.set('POST '+path,{middleware,handler})
    },
    ...(auth?{auth:{needsPermission:capability=>{
      permissions.push(capability);return ()=>true;
    }}}:{})
  };
  register(RED);
  return {RED,registered,routes,permissions};
}
function createNode(entry,config){
  const Constructor=entry.registered.get('tinner-graph-runtime');
  assert.equal(typeof Constructor,'function');
  return new Constructor(config);
}
function send(node,command,payload){
  return new Promise((resolve,reject)=>{
    let output;
    const msg={_msgid:'test-message',payload,tinnerGraph:command};
    node._events.input(msg,received=>{output=received;},err=>
      err?reject(err):resolve(output));
  });
}
async function http(route,req={}){
  const out={statusCode:200,body:null,
    status(code){this.statusCode=code;return this;},
    json(body){this.body=body;return this;}
  };
  await route.handler({params:{id:req.id||'graph-one'},body:req.body},out);
  return out;
}

test('catalog publishes fixed typed microprograms without dynamic code evaluation',async()=>{
  const runtime=new GraphRuntime();
  const result=await runtime.dispatch({action:'catalog'});
  assert.equal(result.definitions.length,6);
  assert.deepEqual(result.definitions,catalog());
  assert.equal(result.definitions.some(d=>d.id==='mechanicus.math.offset'),true);
  assert.equal(result.definitions.some(d=>Object.hasOwn(d,'run')),false);
});

test('visual Node-RED graph runtime stages, activates, invokes and rolls back in-place',async()=>{
  const installed=registry(),node=createNode(installed,{id:'graph-one',allowManagement:true});
  const stage=await send(node,{action:'stage',graph:ir()},null);
  assert.equal(stage.tinnerGraphResult.revision,'r1');
  assert.equal(stage.payload,null);
  await send(node,{action:'activate',revision:'r1',expectedActive:null});
  const response=await send(node,{action:'invoke',route:'container/worker'},7);
  assert.equal(response.payload,12);
  assert.deepEqual(response.tinnerGraphResult,{
    action:'invoke',revision:'r1',route:'container/worker'
  });
  await send(node,{action:'stage',graph:ir('r2',20)});
  await send(node,{action:'activate',revision:'r2',expectedActive:'r1'});
  assert.equal((await send(node,{action:'invoke',route:'container/worker'},7)).payload,27);
  const rollback=await send(node,{action:'rollback',expectedActive:'r2'});
  assert.equal(rollback.tinnerGraphResult.revision,'r1');
  assert.equal((await send(node,{action:'invoke',route:'container/worker'},7)).payload,12);
  assert.equal(node._status.fill,'green');
  node._events.close(()=>{});
  assert.equal(node.graphClosed,true);
  assert.equal((await http(installed.routes.get('GET /tinner/graph/:id/status'))).statusCode,404);
});

test('management disabled by default and runtime message errors are fail closed',async()=>{
  const installed=registry(),node=createNode(installed,{id:'graph-one'});
  assert.equal(node.graphRuntime.allowManagement,false);
  await assert.rejects(()=>send(node,{action:'stage',graph:ir()}),/management disabled/);
  await assert.rejects(()=>send(node,{action:'invoke',route:'container/worker'},1),
    /No active graph revision/);
  assert.equal(node._status.fill,'red');
  assert.equal(node._sent.length,0);
  assert.equal((await send(node,{action:'status'})).tinnerGraphResult.status.active,null);
});

test('untrusted graph source and mismatched built-in ABI cannot register handlers',async()=>{
  const r=new GraphRuntime({allowManagement:true});
  const malicious=ir();malicious.definitions[0].id='user.dynamic.javascript';
  await assert.rejects(()=>r.dispatch({action:'stage',graph:malicious}),/No approved built-in handler/);
  const forged=ir();forged.definitions[0].outputs[0].type='any';
  await assert.rejects(()=>r.dispatch({action:'stage',graph:forged}),/port ABI mismatch/);
  const ref=ir();ref.definitions[0].kind='reference';ref.exports=[];
  await r.dispatch({action:'stage',graph:ref});
  await r.dispatch({action:'activate',revision:'r1',expectedActive:null});
  await assert.rejects(()=>r.dispatch({action:'invoke',route:'container/worker'},1),
    /Reference node is not executable|not publicly exported/);
});

test('default CAS protects live revision and breaking public contracts are disabled',async()=>{
  const runtime=new GraphRuntime({allowManagement:true});
  await runtime.dispatch({action:'stage',graph:ir()});
  await assert.rejects(()=>runtime.dispatch({action:'activate',revision:'r1'}),
    /expectedActive/);
  await runtime.dispatch({action:'activate',revision:'r1',expectedActive:null});
  await runtime.dispatch({action:'stage',graph:ir('r2',10)});
  await assert.rejects(()=>runtime.dispatch({action:'activate',revision:'r2',expectedActive:null}),
    /Graph revision conflict/);
  await assert.rejects(()=>runtime.dispatch({action:'activate',revision:'r2',
    expectedActive:'r1',allowBreaking:true}),/Breaking public contracts/);
  const status=await runtime.dispatch({action:'status'});
  assert.equal(status.status.active,'r1');
});

test('bounded node parameters and type validation prevent invalid arithmetic',async()=>{
  const runtime=new GraphRuntime({allowManagement:true});
  await runtime.dispatch({action:'stage',graph:ir()});
  await runtime.dispatch({action:'activate',revision:'r1',expectedActive:null});
  await assert.rejects(()=>runtime.dispatch({action:'invoke',route:'container/worker'},'7'),
    /Invalid typed input/);
  const second=ir('bad',2000000);
  await runtime.dispatch({action:'stage',graph:second});
  await runtime.dispatch({action:'activate',revision:'bad',expectedActive:'r1'});
  await assert.rejects(()=>runtime.dispatch({action:'invoke',route:'container/worker'},7),
    /Invalid numeric node parameter/);
});

test('evict keeps active or rollback-protected revisions while allowing unused staging cleanup',async()=>{
  const runtime=new GraphRuntime({allowManagement:true});
  await runtime.dispatch({action:'stage',graph:ir()});
  await runtime.dispatch({action:'activate',revision:'r1',expectedActive:null});
  await runtime.dispatch({action:'stage',graph:ir('unused')});
  assert.equal((await runtime.dispatch({action:'evict',revision:'unused'})).revision,'unused');
  await assert.rejects(()=>runtime.dispatch({action:'evict',revision:'r1'}),
    /Cannot evict/);
  await runtime.dispatch({action:'stage',graph:ir('r2')});
  await runtime.dispatch({action:'activate',revision:'r2',expectedActive:'r1'});
  await assert.rejects(()=>runtime.dispatch({action:'evict',revision:'r1'}),
    /Cannot evict/);
});

test('Node-RED HTTP API registers permissions and allows typed authenticated commands',async()=>{
  const installed=registry();
  const node=createNode(installed,{id:'graph-one',allowManagement:true});
  assert.deepEqual(installed.permissions,['flows.read','flows.write']);
  const status=await http(installed.routes.get('GET /tinner/graph/:id/status'));
  assert.equal(status.statusCode,200);
  assert.equal(status.body.active,null);
  const catalogResponse=await http(installed.routes.get('GET /tinner/graph/:id/catalog'));
  assert.equal(catalogResponse.body.definitions.length,6);
  const stage=await http(installed.routes.get('POST /tinner/graph/:id/command'),
    {body:{action:'stage',graph:ir()}});
  assert.equal(stage.statusCode,200);
  assert.equal(stage.body.status,'staged');
  const active=await http(installed.routes.get('POST /tinner/graph/:id/command'),
    {body:{action:'activate',revision:'r1',expectedActive:null}});
  assert.equal(active.statusCode,200);
  const invoke=await http(installed.routes.get('POST /tinner/graph/:id/command'),
    {body:{action:'invoke',route:'container/worker',payload:9}});
  assert.equal(invoke.statusCode,200);
  assert.equal(invoke.body.value,14);
  const stale=await http(installed.routes.get('POST /tinner/graph/:id/command'),
    {body:{action:'activate',revision:'r1',expectedActive:null}});
  assert.equal(stale.statusCode,409);
  assert.equal(node.graphRuntime.manager.status().active,'r1');
});

test('Node-RED admin commands reject unauthorized management and unknown nodes',async()=>{
  const installed=registry();
  createNode(installed,{id:'graph-one',allowManagement:false});
  const endpoint=installed.routes.get('POST /tinner/graph/:id/command');
  assert.equal((await http(endpoint,{body:{action:'stage',graph:ir()}})).statusCode,403);
  assert.equal((await http(endpoint,{id:'missing',body:{action:'status'}})).statusCode,404);
  assert.equal((await http(endpoint,{body:null})).statusCode,400);
});

test('missing Node-RED auth cannot accidentally expose management HTTP routes',()=>{
  const installed=registry({auth:false});
  assert.equal(installed.routes.size,0);
  assert.equal(typeof installed.registered.get('tinner-graph-runtime'),'function');
});
