'use strict';

// A CPU-first, allowlisted Graph Manager service for Adamantium-node/Node-RED.
// No eval, VM, source-to-code compilation or implicit file/network access.
const {GraphManager}=require('./graph-manager');
const {catalog,bindingsFor}=require('./graph-catalog');

const MAX_GRAPH_BYTES=4*1024*1024;
const MAX_STAGED=12;
const OPS=new Set(['status','catalog','invoke','stage','activate','rollback','evict']);
const MANAGEMENT=new Set(['stage','activate','rollback','evict']);
function commandName(command) {
  if(!command||typeof command!=='object'||Array.isArray(command)||
     !OPS.has(command.action))throw Error('Unknown Tinner graph action');
  return command.action;
}
class GraphRuntime {
  constructor({allowManagement=false}={}){
    this.manager=new GraphManager();
    this.allowManagement=allowManagement===true;
  }
  async dispatch(command,payload){
    const action=commandName(command);
    if(MANAGEMENT.has(action)&&!this.allowManagement)
      throw Error('Graph management disabled on this Node-RED node');
    if(action==='status')return {action,status:this.manager.status(),
      allowManagement:this.allowManagement};
    if(action==='catalog')return {action,definitions:catalog()};
    if(action==='stage') {
      const ir=command.graph;
      if(!ir||typeof ir!=='object'||Array.isArray(ir))
        throw Error('Stage action requires Universal Graph IR object');
      let bytes;
      try{bytes=Buffer.byteLength(JSON.stringify(ir));}
      catch{throw Error('Invalid or unserializable graph');}
      if(bytes>MAX_GRAPH_BYTES)throw Error('Graph exceeds maximum accepted size');
      if(this.manager.status().staged.length>=MAX_STAGED &&
         !this.manager.status().staged.includes(ir.revision))
        throw Error('Graph revision retention limit reached; evict inactive revisions');
      // Fail closed if a definition has no built-in trusted implementation or
      // attempts to reinterpret a built-in's input/output contract.
      const approved=bindingsFor(ir);
      const result=this.manager.stage(ir,approved);
      return {action,...result};
    }
    if(action==='activate') {
      if(!Object.hasOwn(command,'expectedActive'))
        throw Error('Activation requires expectedActive CAS');
      if(command.allowBreaking===true)
        throw Error('Breaking public contracts are disabled in the Node-RED adapter');
      return {action,...this.manager.activate(command.revision,{
        expectedActive:command.expectedActive
      })};
    }
    if(action==='rollback') {
      if(!Object.hasOwn(command,'expectedActive'))
        throw Error('Rollback requires expectedActive CAS');
      return {action,...this.manager.rollback({expectedActive:command.expectedActive})};
    }
    if(action==='evict')return {action,...this.manager.evict(command.revision)};
    if(action==='invoke') {
      if(typeof command.route!=='string'||!command.route)
        throw Error('Invoke requires a typed graph route');
      const revision=this.manager.status().active;
      const value=await this.manager.invoke(command.route,payload,{
        input:command.input===undefined?'input':command.input,
        output:command.output===undefined?'output':command.output
      });
      return {action,revision,route:command.route,value};
    }
  }
}
module.exports={GraphRuntime,MAX_GRAPH_BYTES,MAX_STAGED};
