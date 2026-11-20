'use strict';

// Opt-in Godot 4 Engine Linux editor build check in disposable Docker.
// SCons/SConstruct execute project-controlled Python; never run on the host,
// mount the original checkout, or claim Docker provides a hostile-code sandbox.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {verifyProject,restoreProject}=require('./project');
const {assertImage,walkOwned,bound}=require('./godot-validator');

function checkTimeout(value) {
  const n=value===undefined?3600000:value;
  if(!Number.isInteger(n)||n<1000||n>7200000)
    throw new Error('Build timeout must be 1000..7200000 ms');
  return n;
}
function checkJobs(value) {
  const n=value===undefined?2:value;
  if(!Number.isInteger(n)||n<1||n>8)
    throw new Error('Build jobs must be 1..8');
  return n;
}
function shaFile(p) {
  const digest=createHash('sha256'), buffer=Buffer.allocUnsafe(1024*1024);
  const fd=fs.openSync(p,'r');
  try {
    for(;;){
      const n=fs.readSync(fd,buffer,0,buffer.length,null);
      if(!n)break;
      digest.update(buffer.subarray(0,n));
    }
  }finally{fs.closeSync(fd);}
  return digest.digest('hex');
}
function buildOutputs(staged) {
  const dir=path.join(staged,'bin');
  if(!fs.existsSync(dir))return [];
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink())
    throw new Error('Unsafe Godot build output directory');
  return fs.readdirSync(dir).filter(name=>
    /^godot\.linuxbsd\.editor(?:\.[A-Za-z0-9_-]+)*$/.test(name))
    .sort().map(name=>{
      const location=path.join(dir,name);
      const info=fs.lstatSync(location);
      if(!info.isFile()||info.isSymbolicLink()||info.size===0)
        throw new Error('Invalid engine build output: '+name);
      return {name,bytes:info.size,sha256:shaFile(location)};
    });
}
function validateEngineBundle(bundle,options={}) {
  const image=assertImage(options.image);
  const jobs=checkJobs(options.jobs),timeoutMs=checkTimeout(options.timeoutMs);
  const manifest=verifyProject(bundle).manifest;
  if(manifest.mode!=='godot-engine')
    throw new Error('Engine build validation requires Godot Engine C++ source');
  const runner=options.runner||spawnSync;
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-engine-'));
  const staged=path.join(temporary,'source');
  const started=Date.now();
  const container='tinner-build-'+randomBytes(10).toString('hex');
  try {
    restoreProject(bundle,staged);
    // Docker --mount values use commas as separators: never allow host path
    // characters that can transform a bind source into additional mount opts.
    if(staged.includes(',')||staged.includes('\n')||staged.includes('\r'))
      throw new Error('Unsafe temporary source path for Docker bind');
    const isPosix=typeof process.getuid==='function';
    const uid=isPosix?(process.getuid()||65534):1000;
    const gid=isPosix?(process.getgid()||65534):1000;
    if(isPosix&&process.getuid()===0)walkOwned(staged,uid,gid);
    const args=[
      'run','--rm','--pull=never','--name='+container,
      '--network=none','--read-only','--cap-drop=ALL',
      '--security-opt=no-new-privileges','--pids-limit=256',
      '--memory=8g','--cpus=2','--user='+uid+':'+gid,
      '--tmpfs','/tmp:rw,nosuid,nodev,size=512m',
      '--mount','type=bind,src='+staged+',dst=/workspace/source',
      '--workdir=/workspace/source',
      '--env','HOME=/tmp','--env','XDG_CACHE_HOME=/tmp',
      '--entrypoint=scons',image,
      '-Q','-j'+jobs,'platform=linuxbsd','target=editor'
    ];
    const settings={
      cwd:temporary,timeout:timeoutMs,maxBuffer:4*1024*1024,encoding:'utf8',
      shell:false,env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:temporary,
        DOCKER_HOST:process.env.DOCKER_HOST||''}
    };
    const output=runner('docker',args,settings);
    if(!output||typeof output!=='object')throw new Error('Invalid Docker build response');
    if(output.error||output.signal) {
      // CLI timeouts can leave a container alive. Remove only our random ID.
      try{runner('docker',['rm','-f',container],{
        timeout:5000,maxBuffer:64*1024,encoding:'utf8',shell:false,
        env:settings.env
      });}catch{}
    }
    const stderr=bound(output.stderr),stdout=bound(output.stdout);
    let binaries=[];
    const exited=output.status===0&&!output.error&&!output.signal;
    if(exited)binaries=buildOutputs(staged);
    const ok=exited&&binaries.length>0;
    return {
      format:'tinner.engine-validation.v1',validator:'docker-godot-linuxbsd-editor-build',
      ok,image,exitCode:typeof output.status==='number'?output.status:null,
      signal:output.signal||null,error:output.error?.message||null,
      stdout,stderr,builds:binaries,checkedFiles:manifest.files.length,
      durationMs:Date.now()-started,
      ...(exited&&!binaries.length?{error:'No nonempty Godot editor binary found in bin/'}:{})
    };
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={validateEngineBundle};
