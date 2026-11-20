#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {splitSource,joinSource,buildFlow}=require('../lib/tinner');
const [cmd,input,output,max]=process.argv.slice(2);
function load(dir) {
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  const parts=manifest.chunks.map((chunk,index)=>{
    const id='part-'+String(index+1).padStart(4,'0');
    if(chunk.id!==id)throw new Error('Invalid manifest chunk ID');
    return {id,source:fs.readFileSync(path.join(dir,'chunks',id+'.txt'),'utf8')};
  });
  return joinSource(manifest,parts);
}
try {
  if(cmd==='split'&&input&&output) {
    const result=splitSource(fs.readFileSync(input,'utf8'),{filename:path.basename(input),maxLines:max===undefined?2000:max});
    fs.mkdirSync(output); // fail instead of overwriting an existing output folder
    const dir=path.join(output,'chunks');
    fs.mkdirSync(dir);
    for(const chunk of result.chunks)fs.writeFileSync(path.join(dir,chunk.id+'.txt'),chunk.source,{flag:'wx'});
    fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(result.manifest,null,2)+'\n',{flag:'wx'});
    fs.writeFileSync(path.join(output,'flow.json'),JSON.stringify(buildFlow(result),null,2)+'\n',{flag:'wx'});
    console.log('Created '+result.chunks.length+' chunks; SHA-256 '+result.manifest.sha256);
  } else if(cmd==='verify'&&input&&!output) {
    const source=load(input);
    console.log('Verified '+Buffer.byteLength(source,'utf8')+' bytes');
  } else if(cmd==='join'&&input&&output) {
    fs.writeFileSync(output,load(input),{flag:'wx'});
    console.log('Restored '+output);
  } else {
    console.log('Usage:\n  tinner split <source-file> <new-directory> [max-lines=2000]\n  tinner verify <directory>\n  tinner join <directory> <new-output-file>');
    process.exitCode=2;
  }
}catch(err){console.error('Tinner: '+err.message);process.exitCode=1;}
