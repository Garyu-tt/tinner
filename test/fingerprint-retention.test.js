'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {scanProject,liveStatus,pruneRevisions,rollbackProject,resumeProject,snapshotSource}=require('../lib/live');
const {verifyProject}=require('../lib/project');
const {snapshotContent}=require('../lib/fingerprint');

function fixture() {
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-hash-'));
  const src=path.join(parent,'godot'),state=path.join(parent,'state');
  fs.mkdirSync(path.join(src,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(src,'project.godot'),'[application]\nconfig/name="hash"\n');
  fs.writeFileSync(path.join(src,'scripts','player.gd'),'extends Node\nfunc ready():\n    return 111\n');
  fs.writeFileSync(path.join(src,'texture.bin'),Buffer.from([0,1,0,255]));
  return {parent,src,state};
}
const cleanup=f=>fs.rmSync(f.parent,{recursive:true,force:true});
const sourcePath=f=>path.join(f.src,'scripts','player.gd');
const pointer=f=>JSON.parse(fs.readFileSync(path.join(f.state,'current.json'),'utf8'));
const savePointer=(f,value)=>fs.writeFileSync(path.join(f.state,'current.json'),JSON.stringify(value,null,2)+'\n');
const revision=(f,id)=>path.join(f.state,'revisions',id);
const allRevisions=f=>fs.readdirSync(path.join(f.state,'revisions')).filter(x=>x.startsWith('rev-')).sort();

test('SHA-256 detects changed source even when old metadata snapshot is spoofed identical',()=>{
  const f=fixture();
  try {
    const first=scanProject(f.src,f.state);
    const before=pointer(f).hashes['scripts/player.gd'];
    fs.writeFileSync(sourcePath(f),'extends Node\nfunc ready():\n    return 222\n');
    const stale=pointer(f);
    // Deliberately hide metadata changes from the legacy comparison.
    stale.snapshot=snapshotSource(f.src);
    savePointer(f,stale);
    const changed=scanProject(f.src,f.state);
    assert.equal(changed.status,'updated');
    assert.equal(changed.processedFiles,1);
    assert.deepEqual(changed.changes.modified,['scripts/player.gd']);
    assert.notEqual(pointer(f).hashes['scripts/player.gd'],before);
    assert.notEqual(first.revision,changed.revision);
    assert.equal(liveStatus(f.state,{verify:true}).verified,3);
  }finally{cleanup(f);}
});

test('touching an unchanged file does not create a new revision',()=>{
  const f=fixture();
  try {
    const first=scanProject(f.src,f.state);
    const filename=sourcePath(f);
    const now=new Date(Date.now()+5000);
    fs.utimesSync(filename,now,now);
    assert.equal(scanProject(f.src,f.state).status,'unchanged');
    assert.equal(pointer(f).revision,first.revision);
    assert.equal(allRevisions(f).length,1);
  }finally{cleanup(f);}
});

test('fingerprint reads binary bytes, respects generated cache exclusion',()=>{
  const f=fixture();
  try{
    fs.mkdirSync(path.join(f.src,'.godot'));
    fs.writeFileSync(path.join(f.src,'.godot','generated.bin'),'excluded');
    const first=snapshotContent(f.src);
    assert.equal(first.snapshot['scripts/player.gd'].length,5);
    assert.ok(!Object.hasOwn(first.hashes,'.godot/generated.bin'));
    assert.match(first.hashes['texture.bin'],/^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(f.src,'texture.bin'),Buffer.from([0,1,0,254]));
    assert.notEqual(snapshotContent(f.src).hashes['texture.bin'],first.hashes['texture.bin']);
  }finally{cleanup(f);}
});

test('legacy v0.7 live state without hashes migrates from the verified old manifest',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.src,f.state);
    const data=pointer(f);
    delete data.hashes;
    savePointer(f,data);
    assert.equal(scanProject(f.src,f.state).status,'unchanged');
    fs.writeFileSync(sourcePath(f),'extends Node\nfunc ready():\n    return 333\n');
    const next=scanProject(f.src,f.state);
    assert.equal(next.processedFiles,1);
    assert.equal(next.reusedFiles,2);
    assert.equal(next.previousRevision,first.revision);
    assert.equal(pointer(f).hashes['scripts/player.gd'].length,64);
    assert.equal(verifyProject(revision(f,next.revision)).verified,3);
  }finally{cleanup(f);}
});

test('retention dry-run preserves all data, then apply keeps active and rollback target',()=>{
  const f=fixture();
  try {
    const ids=[];
    for(let n=0;n<4;n++) {
      fs.writeFileSync(sourcePath(f),'extends Node\nfunc ready():\n    return '+(111+n)+'\n');
      ids.push(scanProject(f.src,f.state).revision);
    }
    assert.equal(allRevisions(f).length,4);
    const dry=pruneRevisions(f.state,2);
    assert.equal(dry.applied,false);
    assert.equal(dry.wouldRemove.length,2);
    assert.equal(allRevisions(f).length,4);
    const res=pruneRevisions(f.state,2,{apply:true});
    assert.equal(res.applied,true);
    assert.equal(res.removed.length,2);
    assert.deepEqual(allRevisions(f),[ids[2],ids[3]].sort());
    assert.equal(rollbackProject(f.state).revision,ids[2]);
    assert.equal(liveStatus(f.state,{verify:true}).verified,3);
    assert.equal(resumeProject(f.state).status,'resumed');
  }finally{cleanup(f);}
});

test('opt-in automatic retention bounds revision count without destroying current or previous',()=>{
  const f=fixture();
  try{
    for(let n=0;n<6;n++){
      fs.writeFileSync(sourcePath(f),'extends Node\nfunc ready():\n    return '+n+'\n');
      const result=scanProject(f.src,f.state,{maxRevisions:3});
      assert.equal(result.status,'updated');
      assert.equal(result.retention?.applied,true);
      assert.ok(allRevisions(f).length<=3);
      const ptr=pointer(f);
      assert.ok(allRevisions(f).includes(ptr.revision));
      if(ptr.previous)assert.ok(allRevisions(f).includes(ptr.previous.revision));
    }
    assert.equal(liveStatus(f.state,{verify:true}).verified,3);
  }finally{cleanup(f);}
});

test('tampered old revisions cannot be silently pruned; live pointer is preserved',()=>{
  const f=fixture();
  try{
    const ids=[];
    for(let n=0;n<3;n++) {
      fs.writeFileSync(sourcePath(f),'extends Node\nfunc ready():\n    return '+n+'\n');
      ids.push(scanProject(f.src,f.state).revision);
    }
    fs.appendFileSync(path.join(revision(f,ids[0]),'project-flow.json'),' ');
    assert.equal(pruneRevisions(f.state,2).wouldRemove.length,1);
    assert.throws(()=>pruneRevisions(f.state,2,{apply:true}),/integrity mismatch/i);
    assert.equal(allRevisions(f).length,3);
    assert.equal(pointer(f).revision,ids[2]);
  }finally{cleanup(f);}
});

test('invalid keep-count and lock contention fail without deleting any revisions',()=>{
  const f=fixture();
  try{
    scanProject(f.src,f.state);
    assert.throws(()=>pruneRevisions(f.state,1,{apply:true}),/maxRevisions/);
    assert.throws(()=>scanProject(f.src,f.state,{maxRevisions:1}),/maxRevisions/);
    assert.equal(allRevisions(f).length,1);
    const lock=path.join(f.state,'.writer.lock');
    fs.writeFileSync(lock,'some writer\n');
    assert.throws(()=>pruneRevisions(f.state,2,{apply:true}),/writer lock/);
    fs.unlinkSync(lock);
    assert.equal(allRevisions(f).length,1);
  }finally{cleanup(f);}
});

test('CLI prune is dry-run by default and requires explicit --apply for deletion',()=>{
  const f=fixture();
  try{
    for(let n=0;n<4;n++) {
      fs.writeFileSync(sourcePath(f),'extends Node\nfunc ready():\n    return '+n+'\n');
      scanProject(f.src,f.state);
    }
    const bin=path.resolve(__dirname,'../bin/tinner.js');
    const dry=spawnSync(process.execPath,[bin,'live-prune',f.state,'2'],{encoding:'utf8'});
    assert.equal(dry.status,0,dry.stderr);
    assert.equal(JSON.parse(dry.stdout).wouldRemove.length,2);
    assert.equal(allRevisions(f).length,4);
    const run=spawnSync(process.execPath,[bin,'live-prune',f.state,'2','--apply'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    assert.equal(JSON.parse(run.stdout).removed.length,2);
    assert.equal(allRevisions(f).length,2);
  }finally{cleanup(f);}
});
