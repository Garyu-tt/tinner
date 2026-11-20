'use strict';
const {splitSource,joinSource,buildFlow,sha}=require('../lib/tinner');
module.exports=function(RED) {
  function Split(config) {
    RED.nodes.createNode(this,config);
    const node=this;
    node.on('input',(msg,send,done)=>{
      try {
        const result=splitSource(msg.payload,{filename:msg.filename||'source.txt',maxLines:config.maxLines||2000,semantic:config.semantic!==false});
        msg.payload={manifest:result.manifest,flow:buildFlow(result)};
        send(msg); if(done)done();
      } catch(err) { if(done)done(err); else node.error(err,msg); }
    });
  }
  function Chunk(config) {
    RED.nodes.createNode(this,config);
    const node=this;
    node.on('input',(msg,send,done)=>{
      try {
        const index=Number(config.index);
        if(!Number.isInteger(index)||index<0)throw new Error('Bad chunk index');
        if(index===0)msg._tinnerParts=[];
        if(!Array.isArray(msg._tinnerParts)||msg._tinnerParts.length!==index)throw new Error('Chunk order mismatch');
        msg._tinnerParts.push({id:config.partId,source:config.source});
        send(msg); if(done)done();
      }catch(err){if(done)done(err);else node.error(err,msg);}
    });
  }
  function Join(config) {
    RED.nodes.createNode(this,config);
    const node=this;
    node.on('input',(msg,send,done)=>{
      try{
        const manifest=JSON.parse(config.manifest);
        const source=joinSource(manifest,msg._tinnerParts);
        delete msg._tinnerParts;
        msg.payload=source;
        msg.tinner={verified:true,sha256:sha(source),filename:manifest.filename,language:manifest.language};
        send(msg);if(done)done();
      }catch(err){if(done)done(err);else node.error(err,msg);}
    });
  }
  RED.nodes.registerType('tinner',Split);
  RED.nodes.registerType('tinner-chunk',Chunk);
  RED.nodes.registerType('tinner-join',Join);
  function ProjectModule(config) {
    RED.nodes.createNode(this,config);
    // Structural metadata only. Even a cyclic dependency graph must never
    // execute scripts or propagate messages along dependency edges.
    this.on('input',(_msg,_send,done)=>{ if(done)done(); });
  }
  RED.nodes.registerType('tinner-project-module',ProjectModule);
};
