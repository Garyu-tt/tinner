'use strict';

// Adamantium-node/Node-RED runtime adapter for the independently versioned
// Graph Manager. Administrative HTTP endpoints use Node-RED's own auth
// middleware. No unauthenticated API fallback, eval or file-based handlers.
const {GraphRuntime}=require('../lib/graph-runtime');

module.exports=function(RED){
  const instances=new Map();
  function GraphNode(config){
    RED.nodes.createNode(this,config);
    const node=this;
    const graph=new GraphRuntime({allowManagement:config.allowManagement===true});
    node.graphRuntime=graph;
    node.graphClosed=false;
    instances.set(node.id,node);
    node.status?.({fill:'grey',shape:'ring',text:'graph idle'});
    node.on('input',(msg,send,done)=>{
      send=send||node.send?.bind(node);
      Promise.resolve().then(()=>graph.dispatch(msg?.tinnerGraph,msg?.payload))
        .then(result=>{
          if(node.graphClosed)return;
          msg.tinnerGraphResult=result.action==='invoke'?
            {action:'invoke',revision:result.revision,route:result.route}:
            result;
          if(result.action==='invoke')msg.payload=result.value;
          if(typeof send==='function')send(msg);
          const active=graph.manager.status().active;
          node.status?.({fill:active?'green':'grey',shape:'dot',
            text:active?'rev '+active:'graph idle'});
          if(typeof done==='function')done();
        }).catch(error=>{
          if(node.graphClosed)return;
          node.status?.({fill:'red',shape:'ring',text:'graph rejected'});
          if(typeof done==='function')done(error);
          else node.error?.(error,msg);
        });
    });
    node.on('close',(removed,done)=>{
      node.graphClosed=true;
      instances.delete(node.id);
      if(typeof removed==='function')removed();
      else if(typeof done==='function')done();
    });
  }
  RED.nodes.registerType('tinner-graph-runtime',GraphNode);
  // Missing auth middleware MUST NOT expose any management endpoint.
  if(!RED.httpAdmin||!RED.auth||typeof RED.auth.needsPermission!=='function')
    return;
  const canRead=RED.auth.needsPermission('flows.read');
  const canWrite=RED.auth.needsPermission('flows.write');
  RED.httpAdmin.get('/tinner/graph/:id/status',canRead,(req,res)=>{
    const node=instances.get(req.params.id);
    if(!node)return res.status(404).json({code:'not_found'});
    return res.json({nodeId:node.id,
      ...node.graphRuntime.manager.status(),
      allowManagement:node.graphRuntime.allowManagement});
  });
  RED.httpAdmin.get('/tinner/graph/:id/catalog',canRead,async(req,res)=>{
    const node=instances.get(req.params.id);
    if(!node)return res.status(404).json({code:'not_found'});
    try {return res.json(await node.graphRuntime.dispatch({action:'catalog'}));}
    catch{return res.status(500).json({code:'internal_error'});}
  });
  RED.httpAdmin.post('/tinner/graph/:id/command',canWrite,async(req,res)=>{
    const node=instances.get(req.params.id);
    if(!node)return res.status(404).json({code:'not_found'});
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))
      return res.status(400).json({code:'invalid_command'});
    try {
      const result=await node.graphRuntime.dispatch(req.body,req.body.payload);
      return res.json(result);
    }catch(err){
      // Do not return request payloads or stack traces.
      const message=String(err?.message||'rejected');
      const status=/revision conflict|CAS|different graph content|different trusted handler/i.test(message)
        ?409:/management disabled/i.test(message)?403:400;
      return res.status(status).json({code:'graph_rejected',message});
    }
  });
};
