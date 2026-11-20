#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {splitSource,joinSource,buildFlow}=require('../lib/tinner');
const {exportProject,verifyProject,restoreProject}=require('../lib/project');
const {scanProject,liveStatus,rollbackProject,resumeProject,watchProject,pruneRevisions}=require('../lib/live');
const {validateGodotBundle}=require('../lib/godot-validator');
const {validateEngineBundle}=require('../lib/godot-engine-validator');
const rawArgs=process.argv.slice(2);
function readFlag(name) {
  const values=rawArgs.filter(value=>value.startsWith('--'+name+'='));
  if(values.length>1)throw new Error('Duplicate option --'+name);
  return values[0]?.slice(name.length+3);
}
const validateImage=readFlag('validate-image');
const engineBuildImage=readFlag('engine-build-image');
const smokeScene=readFlag('smoke-scene');
const jobsText=readFlag('build-jobs');
const engineBuildJobs=jobsText===undefined?undefined:Number(jobsText);
const known=new Set(['validate-image','engine-build-image','smoke-scene','build-jobs']);
const remaining=rawArgs.filter(value=>!([...known].some(name=>value.startsWith('--'+name+'='))));
const [cmd,input,output,max,retention]=remaining;
const checkOpts={
  ...(validateImage===undefined?{}:{validateImage}),
  ...(engineBuildImage===undefined?{}:{engineBuildImage}),
  ...(smokeScene===undefined?{}:{smokeScene}),
  ...(engineBuildJobs===undefined?{}:{engineBuildJobs})
};
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
  if (cmd==='project-engine-validate' && input && !output && engineBuildImage) {
    const result=validateEngineBundle(input,{image:engineBuildImage,jobs:engineBuildJobs});
    console.log(JSON.stringify(result,null,2));
    if(!result.ok)process.exitCode=1;
  } else if (cmd==='project-validate' && input && !output && validateImage) {
    const result=validateGodotBundle(input,{image:validateImage,smokeScene});
    console.log(JSON.stringify(result,null,2));
    if(!result.ok)process.exitCode=1;
  } else if (cmd==='live-scan' && input && output) {
    const result=scanProject(input,output,{
      maxLines:max===undefined?2000:Number(max),
      ...(retention===undefined?{}:{maxRevisions:Number(retention)}),
      ...checkOpts
    });
    console.log(JSON.stringify(result,null,2));
  } else if (cmd==='live-watch' && input && output) {
    const ms=max===undefined?15000:Number(max);
    const stop=watchProject(input,output,{
      pollMs:ms,
      ...(retention===undefined?{}:{maxRevisions:Number(retention)}),
      ...checkOpts,
      onEvent:event=>{
      if(event.status==='unchanged')return;
      console.log(JSON.stringify(event));
    }});
    process.once('SIGINT',()=>{stop();process.exitCode=0;});
    process.once('SIGTERM',()=>{stop();process.exitCode=0;});
  } else if (cmd==='live-prune' && input && output) {
    if(max!==undefined && max!=='--apply')throw new Error('Only --apply is supported as a prune modifier');
    console.log(JSON.stringify(pruneRevisions(input,Number(output),{apply:max==='--apply'}),null,2));
  } else if (cmd==='live-status' && input && !output) {
    console.log(JSON.stringify(liveStatus(input,{verify:true}),null,2));
  } else if (cmd==='live-rollback' && input && !output) {
    console.log(JSON.stringify(rollbackProject(input),null,2));
  } else if (cmd==='live-resume' && input && !output) {
    console.log(JSON.stringify(resumeProject(input),null,2));
  } else if(cmd==='project'&&input&&output) {
    const result=exportProject(input,output,{maxLines:max===undefined?2000:max});
    console.log('Godot project exported: '+result.manifest.files.length+' files; '+result.output);
  } else if(cmd==='project-verify'&&input&&!output) {
    const result=verifyProject(input);
    console.log('Godot project verified: '+result.verified+' files');
  } else if(cmd==='project-restore'&&input&&output) {
    const result=restoreProject(input,output);
    console.log('Godot project restored: '+result.restored+' files; '+result.output);
  } else if(cmd==='split'&&input&&output) {
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
    console.log('Usage:\n  tinner split <source-file> <new-directory> [max-lines=2000]\n  tinner verify <directory>\n  tinner join <directory> <new-output-file>\n  tinner project <godot-project-dir> <new-bundle-dir> [max-lines=2000]\n  tinner project-verify <bundle-dir>\n  tinner project-restore <bundle-dir> <new-godot-dir>\n  tinner live-scan <godot-source> <new-or-managed-state-dir> [max-lines=2000] [max-revisions] [--validate-image=LOCAL_DOCKER_IMAGE]\n  tinner live-watch <godot-source> <new-or-managed-state-dir> [poll-ms=15000] [max-revisions] [--validate-image=LOCAL_DOCKER_IMAGE]\n  tinner live-status <managed-state-dir>\n  tinner live-rollback <managed-state-dir>\n  tinner live-resume <managed-state-dir>\n  tinner live-prune <managed-state-dir> <max-revisions> [--apply]\n  tinner project-validate <bundle-dir> --validate-image=LOCAL_DOCKER_IMAGE [--smoke-scene=res://tests/smoke.tscn]\n  tinner project-engine-validate <engine-bundle> --engine-build-image=LOCAL_BUILDER_IMAGE [--build-jobs=2]');
    process.exitCode=2;
  }
}catch(err){console.error('Tinner: '+err.message);process.exitCode=1;}
