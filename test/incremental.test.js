'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {exportProject,verifyProject,restoreProject}=require('../lib/project');
const {scanProject,liveStatus}=require('../lib/live');

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-incr-'));
  const src=path.join(root,'game'),live=path.join(root,'live');
  fs.mkdirSync(path.join(src,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(src,'scenes'),{recursive:true});
  fs.writeFileSync(path.join(src,'project.godot'),'[application]\nconfig/name="incremental"\n');
  fs.writeFileSync(path.join(src,'scripts','controller.gd'),
    'extends Node\nfunc invoke(x: int) -> int:\n    return calc(x)\nfunc calc(y: int) -> int:\n    return y+1\n');
  fs.writeFileSync(path.join(src,'scenes','player.tscn'),
    '[gd_scene format=3]\n[ext_resource type="Script" path="res://scripts/controller.gd" id="1_a"]\n');
  fs.writeFileSync(path.join(src,'icon.bin'),Buffer.from([0,1,0,255]));
  return {root,src,live};
}
const cleanup=f=>fs.rmSync(f.root,{recursive:true,force:true});
const rev=(f,id)=>path.join(f.live,'revisions',id);
const load=(base)=>JSON.parse(fs.readFileSync(path.join(base,'project-manifest.json'),'utf8'));

test('one changed script reprocesses only that file and reuses unchanged assets',()=>{
  const f=fixture();
  try {
    const first=scanProject(f.src,f.live);
    assert.equal(first.reusedFiles,0);
    assert.equal(first.processedFiles,4);
    fs.writeFileSync(path.join(f.src,'scripts','controller.gd'),
      'extends Node\nfunc invoke(x: int) -> int:\n    return calc(x)\nfunc calc(y: int) -> int:\n    return y+99\n');
    const second=scanProject(f.src,f.live);
    assert.equal(second.status,'updated');
    assert.equal(second.reusedFiles,3);
    assert.equal(second.processedFiles,1);
    assert.deepEqual(second.changes.modified,['scripts/controller.gd']);
    const newBundle=rev(f,second.revision);
    const manifest=load(newBundle);
    assert.equal(manifest.incremental.mode,'baseline-reuse');
    assert.equal(manifest.incremental.reusedFiles,3);
    assert.equal(verifyProject(newBundle).verified,4);
    const restored=path.join(f.root,'restored');
    assert.equal(restoreProject(newBundle,restored).restored,4);
    assert.equal(fs.readFileSync(path.join(restored,'scripts','controller.gd'),'utf8'),
      fs.readFileSync(path.join(f.src,'scripts','controller.gd'),'utf8'));
    assert.deepEqual(fs.readFileSync(path.join(restored,'icon.bin')),
      fs.readFileSync(path.join(f.src,'icon.bin')));
    // Cached semantic graph for unchanged source must be byte-identical.
    assert.deepEqual(fs.readFileSync(path.join(newBundle,'chunks','scenes','player.tscn','part-0001.txt')),
      fs.readFileSync(path.join(rev(f,first.revision),'chunks','scenes','player.tscn','part-0001.txt')));
  }finally{cleanup(f);}
});

test('an added dependency updates references even when parent script was reused',()=>{
  const f=fixture();
  try{
    fs.appendFileSync(path.join(f.src,'scripts','controller.gd'),
      'const ICON = preload("res://scenes/later.tscn")\n');
    const first=scanProject(f.src,f.live);
    const oldScript=load(rev(f,first.revision)).files.find(x=>x.path==='scripts/controller.gd');
    assert.ok(oldScript.unresolved.includes('scenes/later.tscn'));
    fs.writeFileSync(path.join(f.src,'scenes','later.tscn'),'[gd_scene format=3]\n[node name="Later" type="Node"]\n');
    const second=scanProject(f.src,f.live);
    assert.equal(second.processedFiles,1);
    assert.equal(second.reusedFiles,4);
    const script=load(rev(f,second.revision)).files.find(x=>x.path==='scripts/controller.gd');
    assert.ok(script.dependencies.includes('scenes/later.tscn'));
    assert.ok(!script.unresolved.includes('scenes/later.tscn'));
    const graph=JSON.parse(fs.readFileSync(path.join(rev(f,second.revision),'project-flow.json'),'utf8'));
    const from=graph.find(node=>node.relativePath==='scripts/controller.gd');
    const to=graph.find(node=>node.relativePath==='scenes/later.tscn');
    assert.ok(from.wires[0].includes(to.id));
    fs.unlinkSync(path.join(f.src,'scenes','later.tscn'));
    const third=scanProject(f.src,f.live);
    assert.equal(third.processedFiles,0);
    assert.equal(third.reusedFiles,4);
    const script3=load(rev(f,third.revision)).files.find(x=>x.path==='scripts/controller.gd');
    assert.ok(script3.unresolved.includes('scenes/later.tscn'));
    assert.ok(!script3.dependencies.includes('scenes/later.tscn'));
    assert.equal(verifyProject(rev(f,third.revision)).verified,4);
  }finally{cleanup(f);}
});

test('unchanged symbol flow is copied; output equals a clean full rebuild',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.src,f.live);
    fs.writeFileSync(path.join(f.src,'icon.bin'),Buffer.from([0,1,2,3,4]));
    const second=scanProject(f.src,f.live);
    assert.equal(second.reusedFiles,3);
    assert.equal(second.processedFiles,1);
    const manifest=load(rev(f,second.revision));
    assert.equal(manifest.incremental.reusedSymbolFlows,1);
    const fresh=path.join(f.root,'fresh');
    exportProject(f.src,fresh);
    const original=rev(f,second.revision);
    const fullManifest=load(fresh);
    assert.deepEqual(manifest.files,fullManifest.files);
    const products=['symbol-graph.json','project-flow.json','flows/scripts/controller.gd.json',
      'flows/symbols/scripts/controller.gd.json'];
    for(const file of products)assert.deepEqual(
      fs.readFileSync(path.join(original,file)),fs.readFileSync(path.join(fresh,file)),file);
  }finally{cleanup(f);}
});

test('line cap changes force a full rebuild instead of stale reused chunks',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.src,f.live);
    const second=scanProject(f.src,f.live,{maxLines:2});
    assert.equal(second.status,'updated');
    assert.equal(second.settingsChanged,true);
    assert.equal(second.reusedFiles,0);
    assert.equal(second.processedFiles,4);
    assert.notEqual(second.revision,first.revision);
    const last=load(rev(f,second.revision));
    assert.equal(last.maxLines,2);
    for(const file of last.files)if(file.storage==='chunks')
      assert.ok(file.chunkManifest.chunks.every(chunk=>chunk.lineCount<=2));
    const unchanged=scanProject(f.src,f.live,{maxLines:2});
    assert.equal(unchanged.status,'unchanged');
  }finally{cleanup(f);}
});

test('reusing prior revision fails closed when its graph is tampered',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.src,f.live);
    const symbolPath=path.join(rev(f,first.revision),'symbol-graph.json');
    fs.appendFileSync(symbolPath,'tamper');
    fs.writeFileSync(path.join(f.src,'icon.bin'),Buffer.from([7,7,7]));
    assert.throws(()=>scanProject(f.src,f.live),/integrity mismatch/i);
    assert.equal(liveStatus(f.live).revision,first.revision);
    assert.equal(fs.readdirSync(path.join(f.live,'revisions')).length,1);
  }finally{cleanup(f);}
});

test('writer lock prevents simultaneous publishers without losing live pointer',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.src,f.live);
    const lock=path.join(f.live,'.writer.lock');
    fs.writeFileSync(lock,'existing-writer\n');
    fs.writeFileSync(path.join(f.src,'icon.bin'),Buffer.from([1,3,5,7]));
    assert.throws(()=>scanProject(f.src,f.live),/writer lock/);
    assert.equal(liveStatus(f.live).revision,first.revision);
    fs.unlinkSync(lock);
    assert.equal(scanProject(f.src,f.live).status,'updated');
  }finally{cleanup(f);}
});

test('baseline API fails closed on mismatched limits and disallowed cache policy',()=>{
  const f=fixture();
  try {
    const base=path.join(f.root,'base');
    exportProject(f.src,base);
    assert.throws(()=>exportProject(f.src,path.join(f.root,'bad1'),
      {baselineBundle:base,changedPaths:[],maxLines:7}),/Incompatible baseline/);
    assert.throws(()=>exportProject(f.src,path.join(f.root,'bad2'),
      {baselineBundle:base,changedPaths:[],maxTextBytes:1}),/maxTextBytes/);
    assert.throws(()=>exportProject(f.src,path.join(f.root,'bad3'),
      {baselineBundle:base}),/Reuse requires/);
    assert.equal(fs.existsSync(path.join(f.root,'bad1')),false);
    assert.equal(fs.existsSync(path.join(f.root,'bad2')),false);
    assert.equal(fs.existsSync(path.join(f.root,'bad3')),false);
  }finally{cleanup(f);}
});
