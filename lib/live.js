'use strict';

// Tinner Live: synchronous deterministic polling and immutable project revisions.
// It does not execute Godot files, invoke a compiler, or contact an AI API.
// Rebuilds are currently whole-project; an unchanged metadata snapshot skips work.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { exportProject, verifyProject, enumerate } = require('./project');

const FORMAT = 'tinner.live.v1';
const REV = /^rev-[a-f0-9]{24}$/;
const LIVE_MARKER = 'state.json';
const CURRENT = 'current.json';

function inTree(candidate, parent) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..'+path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function assertPlain(p, kind) {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink()) throw new Error('Symlink not allowed in Tinner Live state: '+p);
  if (kind === 'file' && !stat.isFile()) throw new Error('Expected file: '+p);
  if (kind === 'directory' && !stat.isDirectory()) throw new Error('Expected directory: '+p);
}

function loadJson(p) {
  assertPlain(p, 'file');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function isRevision(s) { return typeof s === 'string' && REV.test(s); }

function revisionPath(root, revision) {
  if (!isRevision(revision)) throw new Error('Invalid live revision ID');
  const parent=path.join(root, 'revisions');
  assertPlain(parent,'directory');
  const dir=path.join(parent, revision);
  assertPlain(dir,'directory');
  return dir;
}

function atomicJson(root, name, value) {
  const dest=path.join(root,name);
  if (fs.existsSync(dest)) assertPlain(dest,'file');
  const tmp=path.join(root,'.'+name+'.'+randomBytes(8).toString('hex')+'.tmp');
  let published=false;
  try {
    const fd=fs.openSync(tmp,'wx',0o600);
    try {
      fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n','utf8');
      fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    fs.renameSync(tmp,dest);
    published=true;
  } finally {
    if(!published && fs.existsSync(tmp))fs.unlinkSync(tmp);
  }
}

function readCurrent(state) {
  const file=path.join(state,CURRENT);
  if(!fs.existsSync(file))return null;
  const data=loadJson(file);
  if(data.format!==FORMAT || !isRevision(data.revision) ||
     !data.snapshot || typeof data.snapshot!=='object' || Array.isArray(data.snapshot) ||
     typeof data.paused!=='boolean') throw new Error('Invalid Tinner current pointer');
  if(data.previous!==null && data.previous!==undefined &&
    (!isRevision(data.previous.revision) || !data.previous.snapshot ||
      typeof data.previous.snapshot!=='object')) throw new Error('Invalid previous revision pointer');
  revisionPath(state,data.revision);
  return data;
}

function checkState(state, source) {
  const markerPath=path.join(state,LIVE_MARKER);
  assertPlain(state,'directory');
  const info=loadJson(markerPath);
  if(info.format!==FORMAT || typeof info.sourceRoot!=='string' || !path.isAbsolute(info.sourceRoot))
    throw new Error('Invalid Tinner state marker');
  if(source !== undefined && fs.realpathSync(source)!==info.sourceRoot)
    throw new Error('Live state is pinned to another source root');
  assertPlain(path.join(state,'revisions'),'directory');
  return info;
}

function ensureState(source,state) {
  const root=fs.realpathSync(source);
  assertPlain(root,'directory');
  const target=path.resolve(state);
  if(inTree(target,root)) throw new Error('Live state must be outside the source tree');
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target,{recursive:true,mode:0o700});
    fs.mkdirSync(path.join(target,'revisions'),{mode:0o700});
    atomicJson(target,LIVE_MARKER,{format:FORMAT,sourceRoot:root});
  }
  checkState(target,root);
  return {root,state:target};
}

function snapshotSource(root) {
  const {result}=enumerate(root); // same excluded generated caches as exportProject
  const files={};
  for(const rel of result) {
    const item=path.join(root,...rel.split('/'));
    assertPlain(item,'file');
    const stat=fs.statSync(item,{bigint:true});
    files[rel]=[
      stat.size.toString(),
      stat.mtimeNs.toString(),
      stat.ctimeNs.toString(),
      stat.ino.toString(),
      stat.dev.toString()
    ];
  }
  return files;
}

function changeSet(previous,now) {
  const added=[],removed=[],modified=[];
  for(const p of Object.keys(now)) {
    if(!Object.hasOwn(previous,p))added.push(p);
    else if(JSON.stringify(previous[p])!==JSON.stringify(now[p]))modified.push(p);
  }
  for(const p of Object.keys(previous))if(!Object.hasOwn(now,p))removed.push(p);
  return {added,removed,modified,changed:added.length+removed.length+modified.length};
}

function liveStatus(state,{verify=false}={}) {
  const dest=path.resolve(state);
  checkState(dest);
  const current=readCurrent(dest);
  let verified=null;
  if(current && verify) verified=verifyProject(revisionPath(dest,current.revision)).verified;
  return {status:current?'ready':'empty',revision:current?.revision||null,
    previousRevision:current?.previous?.revision||null,
    paused:current?.paused||false,sourceRoot:loadJson(path.join(dest,LIVE_MARKER)).sourceRoot,
    files:current?Object.keys(current.snapshot).length:0,verified};
}

function scanProject(source,state,options={}) {
  const {root,state:dest}=ensureState(source,state);
  const old=readCurrent(dest);
  if(old?.paused)return {status:'paused',revision:old.revision,changed:0};
  const before=snapshotSource(root);
  const delta=changeSet(old?.snapshot||{},before);
  if(old && delta.changed===0)return {status:'unchanged',revision:old.revision,changed:0};
  if(old) verifyProject(revisionPath(dest,old.revision));
  const rev='rev-'+randomBytes(12).toString('hex');
  const candidate=path.join(dest,'revisions',rev);
  let promoted=false;
  try {
    const result=exportProject(root,candidate,{maxLines:options.maxLines||2000});
    verifyProject(candidate);
    const after=snapshotSource(root);
    if(changeSet(before,after).changed!==0)
      throw new Error('Source changed while exporting; published revision preserved');
    const next={format:FORMAT,revision:rev,
      previous:old?{revision:old.revision,snapshot:old.snapshot,createdAt:old.createdAt}:null,
      snapshot:after,paused:false,createdAt:new Date().toISOString(),
      summary:{files:result.manifest.files.length,changed:delta.changed,
        added:delta.added.length,modified:delta.modified.length,removed:delta.removed.length}};
    atomicJson(dest,CURRENT,next);
    promoted=true;
    return {status:'updated',revision:rev,previousRevision:old?.revision||null,...next.summary,changes:delta};
  } finally {
    // A failed new candidate can be removed; never touch an active or previous revision.
    if(!promoted && fs.existsSync(candidate)) {
      assertPlain(candidate,'directory');
      fs.rmSync(candidate,{recursive:true,force:true});
    }
  }
}

function rollbackProject(state) {
  const dest=path.resolve(state);
  checkState(dest);
  const old=readCurrent(dest);
  if(!old || !old.previous)throw new Error('No previous revision to roll back to');
  const target=revisionPath(dest,old.previous.revision);
  verifyProject(target);
  const next={format:FORMAT,revision:old.previous.revision,
    previous:{revision:old.revision,snapshot:old.snapshot,createdAt:old.createdAt},
    snapshot:old.previous.snapshot,createdAt:old.previous.createdAt||new Date().toISOString(),
    paused:true,summary:{rollbackFrom:old.revision}};
  atomicJson(dest,CURRENT,next);
  return {status:'rolled-back',revision:next.revision,paused:true};
}

function resumeProject(state) {
  const dest=path.resolve(state);
  checkState(dest);
  const current=readCurrent(dest);
  if(!current)throw new Error('No current revision');
  verifyProject(revisionPath(dest,current.revision));
  atomicJson(dest,CURRENT,{...current,paused:false});
  return {status:'resumed',revision:current.revision};
}

function watchProject(source,state,{pollMs=15000,onEvent=()=>{},...options}={}) {
  if(!Number.isInteger(pollMs)||pollMs<1000) throw new Error('pollMs must be >=1000');
  let running=false,closed=false,failures=0;
  function tick() {
    if(running||closed)return;
    running=true;
    try {
      const result=scanProject(source,state,options);
      failures=0;
      onEvent({timestamp:new Date().toISOString(),...result});
    } catch(err) {
      failures++;
      onEvent({timestamp:new Date().toISOString(),status:'error',failures,message:err.message});
    } finally{running=false;}
  }
  tick();
  const interval=setInterval(tick,pollMs);
  return ()=>{closed=true;clearInterval(interval);};
}

module.exports={snapshotSource,changeSet,scanProject,liveStatus,rollbackProject,resumeProject,watchProject};
