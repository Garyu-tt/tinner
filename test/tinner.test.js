'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {splitSource,joinSource,buildFlow}=require('../lib/tinner');
test('splits into <=2000 lines with exact roundtrip',()=>{
 const source=Array.from({length:4321},(_,i)=>'line '+i+'\r\n').join('');
 const r=splitSource(source,{filename:'test.js'});
 assert.deepEqual(r.chunks.map(c=>c.lineCount),[2000,2000,321]);
 assert.equal(joinSource(r.manifest,r.chunks),source);
});
test('preserves Unicode, BOM, CR, CRLF, LF, blank and final lines',()=>{
 for(const s of ['\ufeffПривет 💜\r\nx\n\r','abc','a\n\nb\n','', '\r\n']) {
  const r=splitSource(s,{maxLines:1});
  assert.equal(joinSource(r.manifest,r.chunks),s);
 }
});
test('detects changed or missing parts and invalid limits',()=>{
 const r=splitSource('a\nb\n',{maxLines:1});
 assert.throws(()=>joinSource(r.manifest,r.chunks.slice(0,1)),/count/i);
 assert.throws(()=>joinSource(r.manifest,[{...r.chunks[0],source:'X\n'},r.chunks[1]]),/integrity/i);
 assert.throws(()=>splitSource('x',{maxLines:2001}),/maxLines/);
});
test('graph has one editable code node per chunk and reassembles',()=>{
 const r=splitSource('a\nb\nc',{maxLines:2});
 const flow=buildFlow(r);
 const chunks=flow.filter(x=>x.type==='tinner-chunk');
 assert.equal(chunks.length,2);
 assert.equal(chunks[0].wires[0][0],chunks[1].id);
 assert.equal(joinSource(r.manifest,chunks.map(x=>({id:x.partId,source:x.source}))),'a\nb\nc');
});
test('runtime palette nodes register and pass source through join',()=>{
 const types={};
 const RED={nodes:{
  createNode(node){node.on=(event,fn)=>{node[event]=fn;};},
  registerType(name,constructor){types[name]=constructor;}
 }};
 require('../nodes/tinner')(RED);
 let spec;
 new types.tinner({maxLines:2}).input({payload:'a\nb\nc',filename:'file.js'},msg=>{spec=msg.payload;},err=>{if(err)throw err;});
 let msg={payload:''};
 for(const config of spec.flow.filter(x=>x.type==='tinner-chunk')){
   new types['tinner-chunk'](config).input(msg,result=>{msg=result;},err=>{if(err)throw err;});
 }
 new types['tinner-join'](spec.flow.find(x=>x.type==='tinner-join')).input(msg,result=>{msg=result;},err=>{if(err)throw err;});
 assert.equal(msg.payload,'a\nb\nc');
 assert.equal(msg.tinner.verified,true);
});
