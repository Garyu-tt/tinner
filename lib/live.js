'use strict';

// Tinner Live: synchronous deterministic polling and immutable project revisions.
// It does not execute Godot files, invoke a compiler, or contact an AI API.
// Changed files are reprocessed; verified unchanged chunks and indexes are reused.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { exportProject, verifyProject, enumerate } = require('./project');
const { snapshotContent } = require('./fingerprint');
const { validateGodotBundle } = require('./godot-validator');

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

// Filesystem-level writer lock prevents two watcher processes or a rollback
// from racing to replace the active revision. Stale locks are fail-closed:
// an operator must check the PID and remove the stale file deliberately.
function withWriteLock(state, action) {
  const lock=path.join(state,'.writer.lock');
  let fd;
  try {fd=fs.openSync(lock,'wx',0o600);}
  catch(err) {
    if(err.code==='EEXIST')throw new Error('Live state has an active writer lock');
    throw err;
  }
  try {
    fs.writeSync(fd,String(process.pid)+'\\n');
    fs.fsyncSync(fd);
    return action();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
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
  return withWriteLock(dest,()=>{
    if(options.maxRevisions!==undefined &&
       (!Number.isInteger(options.maxRevisions) || options.maxRevisions<2 ||
        options.maxRevisions>100000))
      throw new Error('maxRevisions must be an integer from 2 to 100000');
    const validateImage=options.validateImage||null;
    const maxLines=options.maxLines===undefined?2000:Number(options.maxLines);
    if(!Number.isInteger(maxLines)||maxLines<1||maxLines>2000)
      throw new Error('maxLines must be 1..2000');
    const old=readCurrent(dest);
    if(old?.paused)return {status:'paused',revision:old.revision,changed:0};
    const before=snapshotContent(root);
    // Upgrade from v0.7: old revision manifests already contain per-file hashes.
    // Do not trust timestamp-only metadata or overwrite a previous revision.
    const oldHashes=old
      ? old.hashes||Object.fromEntries(
        verifyProject(revisionPath(dest,old.revision)).manifest.files.map(
          entry=>[entry.path,entry.sha256]))
      : Object.create(null);
    const delta=changeSet(oldHashes,before.hashes);
    const settingsChanged=old && (old.settings?.maxLines!==maxLines ||
      (old.settings?.validateImage||null)!==validateImage);
    if(old && delta.changed===0 && !settingsChanged)
      return {status:'unchanged',revision:old.revision,changed:0};
    const baseline=old && !settingsChanged?revisionPath(dest,old.revision):null;
    const rev='rev-'+randomBytes(12).toString('hex');
    const candidate=path.join(dest,'revisions',rev);
    let promoted=false;
    try {
      const result=exportProject(root,candidate,{
        maxLines,
        ...(baseline?{baselineBundle:baseline,
          changedPaths:[...delta.added,...delta.modified,...delta.removed]}:{})
      });
      verifyProject(candidate);
      const after=snapshotContent(root);
      if(changeSet(before.hashes,after.hashes).changed!==0 ||
         changeSet(before.snapshot,after.snapshot).changed!==0)
        throw new Error('Source changed while exporting; published revision preserved');
      const manifestHashes=Object.fromEntries(result.manifest.files.map(
        entry=>[entry.path,entry.sha256]));
      if(changeSet(before.hashes,manifestHashes).changed!==0)
        throw new Error('Exported source hashes differ from scanned source');
      let validation=null;
      if(validateImage) {
        validation=validateGodotBundle(candidate,{
          image:validateImage,timeoutMs:options.validationTimeoutMs,
          ...(options.validationRunner?{runner:options.validationRunner}:{})
        });
        atomicJson(dest,'last-validation.json',{
          revision:rev,checkedAt:new Date().toISOString(),...validation
        });
        if(!validation.ok)
          throw new Error('Godot validation rejected candidate: '+(validation.error||
            validation.stderr.slice(0,300)||'process exit '+validation.exitCode));
      }
      const summary={validated:validation?.ok===true,
        validator:validation?.validator||null,
        files:result.manifest.files.length,changed:delta.changed,
        added:delta.added.length,modified:delta.modified.length,removed:delta.removed.length,
        reusedFiles:result.manifest.incremental.reusedFiles,
        processedFiles:result.manifest.incremental.processedFiles,
        settingsChanged:!!settingsChanged};
      const next={format:FORMAT,revision:rev,
        previous:old?{revision:old.revision,snapshot:old.snapshot,hashes:oldHashes,
          createdAt:old.createdAt,settings:old.settings}:null,
        settings:{maxLines,validateImage},snapshot:after.snapshot,hashes:after.hashes,
        paused:false,createdAt:new Date().toISOString(),summary};
      atomicJson(dest,CURRENT,next);
      promoted=true;
      const outcome={status:'updated',revision:rev,previousRevision:old?.revision||null,...summary,changes:delta};
      if(options.maxRevisions!==undefined) {
        try {outcome.retention=pruneUnlocked(dest,options.maxRevisions,true);}
        catch(err){outcome.retentionError=err.message;}
      }
      return outcome;
    } finally {
      if(!promoted && fs.existsSync(candidate)) {
        assertPlain(candidate,'directory');
        fs.rmSync(candidate,{recursive:true,force:true});
      }
    }
  });
}

// Only Tinner-managed revision directories are candidates. The current and
// immediately previous revision are ALWAYS preserved, even with retention=2.
// Dry-run is the default: actual deletion requires an explicit apply flag or
// an opt-in maxRevisions setting on the watcher.
function pruneUnlocked(dest,maxRevisions,apply) {
  if(!Number.isInteger(maxRevisions)||maxRevisions<2||maxRevisions>100000)
    throw new Error('maxRevisions must be an integer from 2 to 100000');
  const current=readCurrent(dest);
  const protectedIds=new Set([current?.revision,current?.previous?.revision].filter(Boolean));
  const parent=path.join(dest,'revisions');
  const items=fs.readdirSync(parent).filter(isRevision).map(name=>{
    const directory=path.join(parent,name);
    assertPlain(directory,'directory');
    const stat=fs.statSync(directory);
    return {id:name,mtime:stat.mtimeMs};
  }).sort((a,b)=>b.mtime-a.mtime||b.id.localeCompare(a.id));
  // Preserve recent history and protected rollback targets without deleting
  // more than requested when the protected set occupies reserved slots.
  const keep=new Set(protectedIds);
  for(const item of items) {
    if(keep.size>=maxRevisions)break;
    keep.add(item.id);
  }
  const candidates=items.filter(item=>!keep.has(item.id)).map(item=>item.id);
  if(apply) {
    // Validate all deletion targets first: a damaged or unusual bundle must
    // be handled explicitly by its owner, never silently destroyed.
    for(const id of candidates)verifyProject(revisionPath(dest,id));
    for(const id of candidates) {
      // State is locked by the caller; don't traverse out of revisions/.
      const dir=revisionPath(dest,id);
      fs.rmSync(dir,{recursive:true,force:false});
    }
  }
  return {kept:items.length-candidates.length,removed:apply?candidates:[],
    wouldRemove:candidates,applied:!!apply};
}
function pruneRevisions(state,maxRevisions,{apply=false}={}) {
  const dest=path.resolve(state);
  checkState(dest);
  return apply?withWriteLock(dest,()=>pruneUnlocked(dest,maxRevisions,true))
    :pruneUnlocked(dest,maxRevisions,false);
}

function rollbackProject(state) {
  const dest=path.resolve(state);
  checkState(dest);
  return withWriteLock(dest,()=>{
    const old=readCurrent(dest);
    if(!old || !old.previous)throw new Error('No previous revision to roll back to');
    const target=revisionPath(dest,old.previous.revision);
    const previousManifest=verifyProject(target).manifest;
    const next={format:FORMAT,revision:old.previous.revision,
      previous:{revision:old.revision,snapshot:old.snapshot,hashes:old.hashes,
        createdAt:old.createdAt,settings:old.settings},
      snapshot:old.previous.snapshot,hashes:old.previous.hashes,
      settings:old.previous.settings||{maxLines:previousManifest.maxLines,validateImage:null},
      createdAt:old.previous.createdAt||new Date().toISOString(),
      paused:true,summary:{rollbackFrom:old.revision}};
    atomicJson(dest,CURRENT,next);
    return {status:'rolled-back',revision:next.revision,paused:true};
  });
}

function resumeProject(state) {
  const dest=path.resolve(state);
  checkState(dest);
  return withWriteLock(dest,()=>{
    const current=readCurrent(dest);
    if(!current)throw new Error('No current revision');
    verifyProject(revisionPath(dest,current.revision));
    atomicJson(dest,CURRENT,{...current,paused:false});
    return {status:'resumed',revision:current.revision};
  });
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

module.exports={snapshotSource,changeSet,scanProject,liveStatus,rollbackProject,resumeProject,watchProject,pruneRevisions};
