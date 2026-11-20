'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {exportProject,verifyProject,restoreProject}=require('../lib/project');

test('auto-detects Godot engine source and resolves C++ include graph with zero AI calls',()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-engine-'));
 const src=path.join(parent,'godot-engine'),bundle=path.join(parent,'bundle'),restored=path.join(parent,'restored');
 try {
   fs.mkdirSync(path.join(src,'core'),{recursive:true});
   fs.mkdirSync(path.join(src,'scene'),{recursive:true});
   fs.mkdirSync(path.join(src,'thirdparty'),{recursive:true});
   fs.writeFileSync(path.join(src,'SConstruct'),'print("scons")\n');
   fs.writeFileSync(path.join(src,'core','SCsub'),'Import("env")\n');
   fs.writeFileSync(path.join(src,'core','object.h'),'#pragma once\nstruct Object {};\n');
   const cpp='#include "core/object.h"\n'+Array.from({length:2010},(_,i)=>'// line '+i+'\n').join('');
   fs.writeFileSync(path.join(src,'scene','main.cpp'),cpp);
   fs.writeFileSync(path.join(src,'thirdparty','asset.bin'),Buffer.from([1,2,0,255]));
   const r=exportProject(src,bundle);
   assert.equal(r.manifest.mode,'godot-engine');
   assert.equal(verifyProject(bundle).verified,5);
   const entry=r.manifest.files.find(e=>e.path==='scene/main.cpp');
   assert.deepEqual(entry.dependencies,['core/object.h']);
   assert.ok(entry.chunkManifest.chunks.every(part=>part.lineCount<=2000));
   assert.equal(entry.chunkManifest.chunks.length,2);
   assert.ok(fs.existsSync(path.join(bundle,'flows','scene','main.cpp.json')));
   assert.ok(fs.existsSync(path.join(bundle,'flows','core','SCsub.json')));
   const graph=JSON.parse(fs.readFileSync(path.join(bundle,'project-flow.json'),'utf8'));
   const scene=graph.find(n=>n.relativePath==='scene/main.cpp');
   const header=graph.find(n=>n.relativePath==='core/object.h');
   assert.ok(scene.wires[0].includes(header.id));
   assert.equal(restoreProject(bundle,restored).restored,5);
   assert.equal(fs.readFileSync(path.join(restored,'scene','main.cpp'),'utf8'),cpp);
   assert.deepEqual(fs.readFileSync(path.join(restored,'thirdparty','asset.bin')),Buffer.from([1,2,0,255]));
 }finally{fs.rmSync(parent,{recursive:true,force:true});}
});
test('does not mistake arbitrary directories for Godot engine sources',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-bad-'));
 try{
   fs.writeFileSync(path.join(root,'SConstruct'),'');
   assert.throws(()=>exportProject(root,path.join(root+'-out')),/Expected Godot game project/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
