'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {
  scanProject,liveStatus,rollbackProject,resumeProject,watchProject,
  snapshotSource,changeSet
}=require('../lib/live');

function fixture() {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-live-test-'));
  const source=path.join(parent,'game');
  const state=path.join(parent,'live');
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(source,'project.godot'),'[application]\nconfig/name="Live fixture"\n');
  fs.writeFileSync(path.join(source,'scripts','player.gd'),'extends Node\nfunc ready() -> int:\n    return 1\n');
  fs.writeFileSync(path.join(source,'texture.bin'),Buffer.from([0,1,2,255,0]));
  return {parent,source,state};
}
function cleanup({parent}) {fs.rmSync(parent,{recursive:true,force:true});}
function file(source,relative){return path.join(source,...relative.split('/'));}
function current(state) {return JSON.parse(fs.readFileSync(path.join(state,'current.json'),'utf8'));}
function revision(state,id){return path.join(state,'revisions',id);}

test('initial live scan creates independently verified immutable revision',()=>{
  const f=fixture();
  try {
    const done=scanProject(f.source,f.state);
    assert.equal(done.status,'updated');
    assert.equal(done.files,3);
    assert.match(done.revision,/^rev-[a-f0-9]{24}$/);
    assert.equal(liveStatus(f.state,{verify:true}).verified,3);
    assert.ok(fs.existsSync(path.join(revision(f.state,done.revision),'symbol-graph.json')));
    assert.ok(fs.existsSync(path.join(revision(f.state,done.revision),'project-flow.json')));
    assert.equal(fs.readFileSync(file(f.source,'scripts/player.gd'),'utf8').includes('return 1'),true);
  } finally {cleanup(f);}
});

test('unchanged metadata snapshot is a no-op, changed file publishes a new revision',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.source,f.state);
    const again=scanProject(f.source,f.state);
    assert.equal(again.status,'unchanged');
    assert.equal(again.revision,first.revision);
    fs.writeFileSync(file(f.source,'scripts/player.gd'),'extends Node\nfunc ready() -> int:\n    return 999\n');
    const updated=scanProject(f.source,f.state);
    assert.equal(updated.status,'updated');
    assert.notEqual(updated.revision,first.revision);
    assert.deepEqual(updated.changes.modified,['scripts/player.gd']);
    const previous=revision(f.state,first.revision);
    assert.ok(fs.existsSync(previous));
    assert.equal(liveStatus(f.state,{verify:true}).previousRevision,first.revision);
    assert.equal(current(f.state).snapshot['scripts/player.gd'].length,5);
  } finally{cleanup(f);}
});

test('rollback verifies previous revision and pauses future automatic rebuilds',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.source,f.state);
    fs.writeFileSync(file(f.source,'scripts/player.gd'),'extends Node\nfunc ready():\n    pass\n');
    const second=scanProject(f.source,f.state);
    assert.equal(rollbackProject(f.state).revision,first.revision);
    assert.equal(liveStatus(f.state).paused,true);
    assert.equal(scanProject(f.source,f.state).status,'paused');
    assert.equal(liveStatus(f.state).revision,first.revision);
    assert.equal(resumeProject(f.state).status,'resumed');
    assert.equal(scanProject(f.source,f.state).status,'updated');
    assert.notEqual(liveStatus(f.state).revision,second.revision);
  } finally{cleanup(f);}
});

test('invalid UTF-8 fails closed without changing current pointer',()=>{
  const f=fixture();
  try {
    const first=scanProject(f.source,f.state);
    fs.writeFileSync(file(f.source,'scripts/player.gd'),Buffer.from([0xc3,0x28]));
    assert.throws(()=>scanProject(f.source,f.state),/encoded|UTF-8|valid/i);
    assert.equal(current(f.state).revision,first.revision);
    assert.equal(fs.readdirSync(path.join(f.state,'revisions')).length,1);
  } finally{cleanup(f);}
});

test('tampered active bundle blocks publication of a new revision',()=>{
  const f=fixture();
  try {
    const first=scanProject(f.source,f.state);
    fs.appendFileSync(path.join(revision(f.state,first.revision),'project-flow.json'),' ');
    fs.writeFileSync(file(f.source,'scripts/player.gd'),'extends Node\nfunc ready():\n    return 3\n');
    assert.throws(()=>scanProject(f.source,f.state),/integrity mismatch/i);
    assert.equal(current(f.state).revision,first.revision);
  } finally{cleanup(f);}
});

test('source deletion and binary asset changes are reported; ignored cache is excluded',()=>{
  const f=fixture();
  try{
    fs.mkdirSync(path.join(f.source,'.godot'),{recursive:true});
    fs.writeFileSync(file(f.source,'.godot/generated.ctex'),'cache');
    const first=snapshotSource(f.source);
    assert.equal(Object.hasOwn(first,'.godot/generated.ctex'),false);
    fs.unlinkSync(file(f.source,'scripts/player.gd'));
    fs.writeFileSync(file(f.source,'texture.bin'),Buffer.from([0,1,2,4,5,6]));
    const delta=changeSet(first,snapshotSource(f.source));
    assert.deepEqual(delta.removed,['scripts/player.gd']);
    assert.deepEqual(delta.modified,['texture.bin']);
  } finally{cleanup(f);}
});

test('output-inside-source and wrong source reuse are forbidden',()=>{
  const f=fixture();
  try {
    assert.throws(()=>scanProject(f.source,path.join(f.source,'live')),/outside/);
    scanProject(f.source,f.state);
    const other=path.join(f.parent,'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other,'project.godot'),'[application]\n');
    assert.throws(()=>scanProject(other,f.state),/pinned to another source/);
  } finally{cleanup(f);}
});

test('CLI status and rollback operate without a Godot process or external service',()=>{
  const f=fixture();
  try {
    scanProject(f.source,f.state);
    const base=path.resolve(__dirname,'../bin/tinner.js');
    const p=spawnSync(process.execPath,[base,'live-status',f.state],{encoding:'utf8'});
    assert.equal(p.status,0,p.stderr);
    const info=JSON.parse(p.stdout);
    assert.equal(info.status,'ready');
    assert.equal(info.verified,3);
    const rollback=spawnSync(process.execPath,[base,'live-rollback',f.state],{encoding:'utf8'});
    assert.equal(rollback.status,1);
    assert.match(rollback.stderr,/No previous revision/);
  } finally{cleanup(f);}
});

test('watch mode notices a change without needing an LLM or further commands',async()=>{
  const f=fixture();
  let stop=()=>{};
  try {
    let ready;
    const observed=new Promise((resolve,reject)=>{
      let updates=0;
      const timeout=setTimeout(()=>reject(new Error('watch did not detect the change')),2800);
      ready=()=>clearTimeout(timeout);
      stop=watchProject(f.source,f.state,{pollMs:1000,onEvent:event=>{
        if(event.status==='error'){clearTimeout(timeout);reject(new Error(event.message));return;}
        if(event.status==='updated' && ++updates===2){clearTimeout(timeout);resolve();}
      }});
    });
    fs.writeFileSync(file(f.source,'scripts/player.gd'),'extends Node\nfunc ready():\n    return 15\n');
    await observed;
    assert.notEqual(liveStatus(f.state).previousRevision,null);
  }finally{stop();if(ready)ready();cleanup(f);}
});
