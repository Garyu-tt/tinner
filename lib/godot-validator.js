'use strict';

// Explicit opt-in validation of a Godot game project in a disposable Docker
// sandbox. Project editor extensions may execute code: never launch Godot on
// the host or bind-mount the original source tree.
// Docker isolation is defense-in-depth, NOT a security boundary for hostile
// workloads against an attacker with container/kernel exploit capabilities.

const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {verifyProject,restoreProject,normalizedRelative}=require('./project');

const IMAGE=/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,240}$/;
const SUSPICIOUS=/(?:^|\n)\s*(?:(?:SCRIPT\s+)?ERROR:|Parse Error:|E\s+\d+:\d+)/i;

function assertImage(image) {
  if(typeof image!=='string'||!IMAGE.test(image)||
     image.startsWith('-')||image.includes('..')||
     image.includes('//')||image.includes('@@'))
    throw new Error('A locally installed Docker image reference is required');
  return image;
}
function walkOwned(root,uid,gid) {
  // The restored tree is generated from a verified, symlink-free bundle.
  const visit=p=>{
    const info=fs.lstatSync(p);
    if(info.isSymbolicLink())throw new Error('Unexpected link in staged Godot project');
    if(typeof fs.chownSync==='function')fs.chownSync(p,uid,gid);
    if(info.isDirectory())for(const name of fs.readdirSync(p))visit(path.join(p,name));
  };
  visit(root);
}
function bound(text,limit=6000) {
  const value=typeof text==='string'?text:Buffer.isBuffer(text)?text.toString('utf8'):'';
  return value.length>limit?value.slice(0,limit)+'\n[truncated]':value;
}
function validateGodotBundle(bundle,options={}) {
  const image=assertImage(options.image);
  const manifest=verifyProject(bundle).manifest;
  if(manifest.mode!=='godot-game')throw new Error('Godot Engine source needs a separate compile validator');
  let scene=null;
  if(options.smokeScene!==undefined && options.smokeScene!==null) {
    if(typeof options.smokeScene!=='string' || !options.smokeScene.startsWith('res://'))
      throw new Error('Smoke scene must be a res:// path to a packaged .tscn');
    const relative=normalizedRelative(options.smokeScene.slice(6));
    if(!relative.endsWith('.tscn')||!manifest.files.some(file=>file.path===relative))
      throw new Error('Smoke scene must exist as a packaged .tscn');
    scene='res://'+relative;
  }
  const timeoutMs=options.timeoutMs===undefined?90000:options.timeoutMs;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)
    throw new Error('Validation timeout must be 1000..600000 ms');
  const runner=options.runner||spawnSync;
  const container='tinner-'+randomBytes(10).toString('hex');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-validation-'));
  const staged=path.join(temporary,'project');
  const started=Date.now();
  let commandArgs,output;
  try {
    restoreProject(bundle,staged);
    if(/[,\n\r]/.test(staged))throw new Error('Unsafe temporary project path for Docker bind');
    const isPosix=typeof process.getuid==='function';
    const uid=isPosix?(process.getuid()||65534):1000;
    const gid=isPosix?(process.getgid()||65534):1000;
    if(isPosix && process.getuid()===0)walkOwned(staged,uid,gid);
    // Docker must already have the configured image; no downloads or network.
    // Limit CPU/memory/processes, revoke Linux capabilities and use a temporary
    // project volume. No host secrets, project source, or Docker socket mounted.
    commandArgs=[
      'run','--rm','--pull=never','--name='+container,
      '--network=none','--read-only','--cap-drop=ALL',
      '--security-opt=no-new-privileges','--pids-limit=128',
      '--memory=1024m','--cpus=2','--user='+uid+':'+gid,
      '--tmpfs','/tmp:rw,nosuid,nodev,size=256m',
      '--mount','type=bind,src='+staged+',dst=/workspace/project',
      '--workdir=/workspace/project',
      '--env','HOME=/tmp','--env','XDG_DATA_HOME=/tmp/godot-data',
      '--env','XDG_CONFIG_HOME=/tmp/godot-config',
      '--env','XDG_CACHE_HOME=/tmp/godot-cache',
      '--entrypoint=godot',image,
      '--headless','--path','/workspace/project','--import'
    ];
    output=runner('docker',commandArgs,{
      cwd:temporary,timeout:timeoutMs,maxBuffer:1024*1024,
      encoding:'utf8',shell:false,
      env:{PATH:process.env.PATH||'/usr/bin:/bin',
        HOME:temporary,DOCKER_HOST:process.env.DOCKER_HOST||''}
    });
    if(!output || typeof output!=='object') throw new Error('Invalid validation subprocess response');
    const stdout=bound(output.stdout),stderr=bound(output.stderr);
    const combined=stdout+'\n'+stderr;
    const failed=output.status!==0 || !!output.signal || !!output.error ||
      SUSPICIOUS.test(combined);
    let smoke=null;
    if(!failed&&scene) {
      const smokeArgs=commandArgs.slice(0,-4).map(arg=>arg==='--name='+container?
        '--name='+container+'-smoke':arg).concat(
          '--headless','--path','/workspace/project',
          '--quit-after','120','--scene',scene
        );
      const sceneOutput=runner('docker',smokeArgs,{
        cwd:temporary,timeout:timeoutMs,maxBuffer:1024*1024,
        encoding:'utf8',shell:false,
        env:{PATH:process.env.PATH||'/usr/bin:/bin',
          HOME:temporary,DOCKER_HOST:process.env.DOCKER_HOST||''}
      });
      if(!sceneOutput||typeof sceneOutput!=='object')throw new Error('Invalid smoke subprocess response');
      if(sceneOutput.error||sceneOutput.signal) {
        try{runner('docker',['rm','-f',container+'-smoke'],{
          timeout:3000,maxBuffer:64*1024,encoding:'utf8',shell:false,
          env:{PATH:process.env.PATH||'/usr/bin:/bin',
            HOME:temporary,DOCKER_HOST:process.env.DOCKER_HOST||''}
        });}catch{}
      }
      smoke={
        scene,ok:sceneOutput.status===0&&!sceneOutput.error&&!sceneOutput.signal&&
          !SUSPICIOUS.test((sceneOutput.stdout||'')+'\n'+(sceneOutput.stderr||'')),
        exitCode:typeof sceneOutput.status==='number'?sceneOutput.status:null,
        error:sceneOutput.error?.message||null,
        stdout:bound(sceneOutput.stdout),stderr:bound(sceneOutput.stderr)
      };
    }
    if(output.error && output.error.code==='ETIMEDOUT') {
      // Docker CLI timeout does not guarantee that the container has exited.
      // Name is random and private to this invocation; never kill an arbitrary
      // container from project-controlled metadata.
      try {runner('docker',['rm','-f',container],{
        timeout:3000,maxBuffer:64*1024,encoding:'utf8',shell:false,
        env:{PATH:process.env.PATH||'/usr/bin:/bin',
          HOME:temporary,DOCKER_HOST:process.env.DOCKER_HOST||''}
      });}catch{}
    }
    return {
      format:'tinner.godot-validation.v1',validator:'docker-godot-import',
      ok:!failed&&(!smoke||smoke.ok),image,
      exitCode:typeof output.status==='number'?output.status:null,
      signal:output.signal||null,
      error:output.error?.message||null,
      stdout,stderr,smoke,durationMs:Date.now()-started,
      checkedFiles:manifest.files.length
    };
  } finally {
    fs.rmSync(temporary,{recursive:true,force:true});
  }
}
module.exports={validateGodotBundle,assertImage,walkOwned,bound};
