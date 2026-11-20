'use strict';

// Native CPU-first typed graph coordinator. The caller supplies trusted
// handlers; graph JSON never becomes executable code. All in-flight work
// retains the previous generation when the active pointer changes.
const crypto=require('node:crypto');
const FORMAT='mechanicus.universal-graph/1';
const NAME=/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const TYPES=new Set(['any','json','string','number','boolean','bytes']);
const clone=x=>JSON.parse(JSON.stringify(x));
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.freeze(x);for(const v of Object.values(x))freeze(v);}return x;};
function named(value,label){if(typeof value!=='string'||!NAME.test(value))throw Error('Invalid '+label);return value;}
function ports(value,label){
  if(!Array.isArray(value)||value.length>64)throw Error('Invalid '+label+' port list');
  const names=new Set();
  for(const port of value){
    if(!port||typeof port!=='object')throw Error('Invalid '+label+' port');
    named(port.name,label+' port name');
    if(names.has(port.name)||!TYPES.has(port.type))throw Error('Duplicate or unsupported '+label+' port');
    names.add(port.name);
  }
}
const findPort=(def,name,side)=>(def[side]||[]).find(p=>p.name===name);
const assignable=(a,b)=>a==='any'||b==='any'||a===b;
function valueType(type,value){
  if(type==='any')return true;
  if(type==='bytes')return Buffer.isBuffer(value)||value instanceof Uint8Array;
  if(type==='string')return typeof value==='string';
  if(type==='number')return typeof value==='number'&&Number.isFinite(value);
  if(type==='boolean')return typeof value==='boolean';
  if(type==='json'){try{return value!==undefined&&JSON.stringify(value)!==undefined;}catch{return false;}}
  return false;
}
function resolvePath(snapshot,route) {
  if(typeof route!=='string')throw Error('Invalid graph route');
  const parts=route.split('/');
  if(!parts.length||parts.length>32||parts.some(p=>!NAME.test(p)))throw Error('Invalid graph route');
  let graph=snapshot.graphs.get(snapshot.root);
  if(!graph)throw Error('Missing root graph');
  for(let i=0;i<parts.length;i++){
    const node=graph.local.get(parts[i]);
    if(!node)throw Error('Unknown graph node '+parts[i]);
    if(i===parts.length-1)return {graph,node};
    if(!node.graphRef)throw Error('Path crosses a non-container node');
    graph=snapshot.graphs.get(node.graphRef);
  }
}
function compileGraph(untrusted,providedHandlers=new Map()) {
  if(!untrusted||typeof untrusted!=='object'||Array.isArray(untrusted)||
     untrusted.format!==FORMAT)throw Error('Unsupported Universal Graph IR format');
  if(!(providedHandlers instanceof Map))throw Error('Trusted handlers must be a Map');
  const ir=freeze(clone(untrusted));
  named(ir.namespace,'namespace');named(ir.revision,'revision');named(ir.root,'root graph');
  if(!Array.isArray(ir.definitions)||!Array.isArray(ir.graphs)||
     ir.definitions.length>100000||ir.graphs.length>10000)
    throw Error('Invalid graph definitions or nested graphs');
  const definitions=new Map();
  for(const def of ir.definitions){
    named(def.id,'definition ID');
    if(!Number.isInteger(def.version)||def.version<1||def.version>1000000)throw Error('Invalid definition version');
    if(!['reference','handler'].includes(def.kind))throw Error('Unknown definition kind');
    ports(def.inputs,'input');ports(def.outputs,'output');
    const key=def.id+'@'+def.version;
    if(definitions.has(key))throw Error('Duplicate definition '+key);
    definitions.set(key,def);
    if(def.kind==='handler'&&typeof providedHandlers.get(key)!=='function')
      throw Error('Trusted handler is missing: '+key);
  }
  const graphs=new Map(),nodes=new Map();
  for(const graph of ir.graphs){
    named(graph.id,'graph ID');
    if(graphs.has(graph.id))throw Error('Duplicate nested graph ID');
    ports(graph.inputs||[],'graph input');ports(graph.outputs||[],'graph output');
    if(!Array.isArray(graph.nodes)||!Array.isArray(graph.connections)||
       graph.nodes.length>100000||graph.connections.length>200000)
      throw Error('Invalid graph nodes or connections');
    const local=new Map();
    for(const n of graph.nodes){
      named(n.id,'node ID');
      if(local.has(n.id)||nodes.has(n.id))throw Error('Duplicate node instance ID');
      if((typeof n.definition==='string')===(typeof n.graphRef==='string'))
        throw Error('Node must have exactly one definition or nested graph reference');
      if(n.definition&&!definitions.has(n.definition))throw Error('Unresolved definition '+n.definition);
      if(n.graphRef)named(n.graphRef,'nested graph reference');
      local.set(n.id,n);nodes.set(n.id,n);
    }
    graphs.set(graph.id,{...graph,local});
  }
  if(!graphs.has(ir.root))throw Error('Missing root graph');
  const visiting=new Set(),visited=new Set();
  function walk(id){
    if(visiting.has(id))throw Error('Recursive nested graph');
    if(visited.has(id))throw Error('Nested graph has multiple parents');
    const graph=graphs.get(id);if(!graph)throw Error('Unresolved nested graph '+id);
    visiting.add(id);
    for(const n of graph.nodes)if(n.graphRef)walk(n.graphRef);
    visiting.delete(id);visited.add(id);
  }
  walk(ir.root);
  if(visited.size!==graphs.size)throw Error('Orphan nested graph');
  for(const graph of graphs.values()){
    const edges=new Map(graph.nodes.map(n=>[n.id,[]])),keys=new Set();
    for(const c of graph.connections){
      const from=graph.local.get(c.from?.node),to=graph.local.get(c.to?.node);
      if(!from||!to)throw Error('Connection escapes nested graph');
      const fdef=from.definition?definitions.get(from.definition):graphs.get(from.graphRef);
      const tdef=to.definition?definitions.get(to.definition):graphs.get(to.graphRef);
      const output=findPort(fdef,c.from.port,'outputs'),input=findPort(tdef,c.to.port,'inputs');
      if(!output||!input||!assignable(output.type,input.type))
        throw Error('Missing or incompatible typed port connection');
      const id=[from.id,c.from.port,to.id,c.to.port].join('\0');
      if(keys.has(id))throw Error('Duplicate graph connection');
      keys.add(id);edges.get(from.id).push(to.id);
    }
    const stack=new Set(),done=new Set();
    function check(id){
      if(stack.has(id))throw Error('Cyclic executable connection');
      if(done.has(id))return;
      stack.add(id);
      for(const next of edges.get(id))check(next);
      stack.delete(id);done.add(id);
    }
    for(const id of edges.keys())check(id);
  }
  if(!Array.isArray(ir.dependencies||[]))throw Error('Invalid reference dependencies');
  for(const edge of ir.dependencies||[])
    if(!nodes.has(edge.from)||!nodes.has(edge.to))throw Error('Unresolved reference dependency');
  if(!Array.isArray(ir.exports||[]))throw Error('Invalid public entries');
  const publicEntries=new Map();
  for(const entry of ir.exports||[]){
    const {node}=resolvePath({graphs,root:ir.root},entry.path);
    if(!node.definition)throw Error('Container cannot be public handler entry');
    const def=definitions.get(node.definition);
    if(def.kind!=='handler')throw Error('Reference nodes are not executable');
    const input=findPort(def,entry.input,'inputs'),output=findPort(def,entry.output,'outputs');
    if(!input||!output||publicEntries.has(entry.path))throw Error('Invalid or duplicate public entry');
    publicEntries.set(entry.path,{input:input.type,output:output.type});
  }
  return {ir,graphs,definitions,nodes,handlers:new Map(providedHandlers),publicEntries,
    hash:crypto.createHash('sha256').update(JSON.stringify(ir)).digest('hex')};
}
function compatibility(previous,next){
  const breaks=[];
  for(const [route,contract] of previous.publicEntries){
    const future=next.publicEntries.get(route);
    if(!future||future.input!==contract.input||future.output!==contract.output)
      breaks.push(route);
  }
  return breaks;
}
class GraphManager{
  constructor(){this._staged=new Map();this._active=null;this._history=[];this._inflight=new Map();}
  stage(ir,handlers=new Map()){
    const candidate=compileGraph(ir,handlers),revision=candidate.ir.revision;
    if(this._staged.has(revision)){
      const prior=this._staged.get(revision);
      if(prior.hash!==candidate.hash)
        throw Error('Revision already staged with different graph content');
      if(prior.handlers.size!==candidate.handlers.size ||
         [...prior.handlers].some(([key,handler])=>candidate.handlers.get(key)!==handler))
        throw Error('Revision already staged with different trusted handler bindings');
      return {status:'already-staged',revision,graphHash:candidate.hash};
    }
    this._staged.set(revision,candidate);
    return {status:'staged',revision,graphs:candidate.graphs.size,
      nodes:candidate.nodes.size,definitions:candidate.definitions.size,graphHash:candidate.hash};
  }
  activate(revision,{expectedActive,allowBreaking=false}={}){
    if(expectedActive===undefined)throw Error('Explicit expectedActive is required');
    const active=this._active,old=active?.ir.revision||null;
    if(old!==expectedActive)throw Error('Graph revision conflict (CAS)');
    const next=this._staged.get(revision);
    if(!next)throw Error('Unknown staged graph revision');
    if(active&&active.ir.namespace!==next.ir.namespace)throw Error('Graph namespace mismatch');
    if(active&&!allowBreaking){
      const breaks=compatibility(active,next);
      if(breaks.length)throw Error('Breaking public port contracts: '+breaks.join(','));
    }
    if(active&&old!==revision)this._history.push(old);
    this._active=next;
    return {status:'active',revision,from:old,graphHash:next.hash,
      oldInflight:this._inflight.get(old)||0};
  }
  rollback({expectedActive}={}){
    if(expectedActive===undefined||this._active?.ir.revision!==expectedActive)
      throw Error('Rollback requires exact active graph revision');
    if(!this._history.length)throw Error('No previous graph revision');
    const next=this._history.pop();
    this._active=this._staged.get(next);
    return {status:'rolled-back',revision:next,from:expectedActive};
  }
  status(){
    return {active:this._active?.ir.revision||null,staged:[...this._staged.keys()],
      inflight:Object.fromEntries(this._inflight),availableRollback:this._history.at(-1)||null};
  }
  async invoke(route,payload,{input='input',output='output'}={}){
    const snapshot=this._active;
    if(!snapshot)throw Error('No active graph revision');
    const rev=snapshot.ir.revision;
    this._inflight.set(rev,(this._inflight.get(rev)||0)+1);
    try{
      const location=resolvePath({graphs:snapshot.graphs,root:snapshot.ir.root},route);
      if(location.node.definition && !snapshot.publicEntries.has(route))
        throw Error('Graph entry point is not publicly exported');
      const contract=snapshot.publicEntries.get(route);
      if(contract) {
        const def=snapshot.definitions.get(location.node.definition);
        if(findPort(def,input,'inputs')?.type!==contract.input ||
           findPort(def,output,'outputs')?.type!==contract.output)
          throw Error('Public graph entry port contract mismatch');
      }
      return await this._call(snapshot,location,payload,input,output);
    }finally{
      const remaining=this._inflight.get(rev)-1;
      if(remaining)this._inflight.set(rev,remaining);
      else this._inflight.delete(rev);
    }
  }
  async _call(snapshot,location,payload,inputName,outputName){
    const {graph,node}=location;
    if(!node.definition)throw Error('Container node is not executable');
    const def=snapshot.definitions.get(node.definition);
    if(def.kind!=='handler')throw Error('Reference node is not executable');
    const input=findPort(def,inputName,'inputs'),output=findPort(def,outputName,'outputs');
    if(!input||!output||!valueType(input.type,payload))throw Error('Invalid typed input for '+node.id);
    const invoke=async(targetId,value,{fromPort=outputName,toPort='input',returnPort='output'}={})=>{
      const edge=graph.connections.find(c=>c.from.node===node.id&&
        c.from.port===fromPort&&c.to.node===targetId&&c.to.port===toPort);
      if(!edge)throw Error('Undeclared graph dependency '+node.id+' -> '+targetId);
      return this._call(snapshot,{graph,node:graph.local.get(targetId)},value,toPort,returnPort);
    };
    const result=await snapshot.handlers.get(node.definition)(payload,{
      revision:snapshot.ir.revision,nodeId:node.id,invoke
    });
    if(!valueType(output.type,result))throw Error('Invalid typed output from '+node.id);
    return result;
  }
}
module.exports={FORMAT,compileGraph,GraphManager,resolvePath,compatibility};
