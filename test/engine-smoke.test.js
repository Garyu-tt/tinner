'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {exportProject}=require('../lib/project');
const {validateEngineBundle}=require('../lib/godot-engine-validator');
const {validateGodotBundle}=require('../lib/godot-validator');
const {scanProject,liveStatus}=require('../lib/live');

function fixture(mode='godot-engine') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-v10-'));
  const source=path.join(root,'src'),bundle=path.join(root,'bundle'),state=path.join(root,'state');
  fs.mkdirSync(source);
  if(mode==='godot-engine') {
    fs.mkdirSync(path.join(source,'core'));
    fs.mkdirSync(path.join(source,'scene'));
    fs.writeFileSync(path.join(source,'SConstruct'),'env = Environment()\n');
    fs.writeFileSync(path.join(source,'scene','main.cpp'),'void Engine::boot() { test(); }\n');
    fs.writeFileSync(path.join(source,'core','foo.h'),'#pragma once\n');
  }else{
    fs.mkdirSync(path.join(source,'tests'));
    fs.writeFileSync(path.join(source,'project.godot'),'[application]\nconfig/name="smoke"\n');
    fs.writeFileSync(path.join(source,'tests','smoke.tscn'),
      '[gd_scene format=3]\n[node name="Smoke" type="Node"]\n');
    fs.writeFileSync(path.join(source,'main.gd'),'extends Node\n');
  }
  return {root,source,bundle,state};
}
const destroy=f=>fs.rmSync(f.root,{recursive:true,force:true});
const current=f=>JSON.parse(fs.readFileSync(path.join(f.state,'current.json'),'utf8'));
const binder=args=>{
  const mount=args[args.indexOf('--mount')+1];
  assert.match(mount,/^type=bind,src=/);
  return mount.slice('type=bind,src='.length).split(',dst=')[0];
};
function buildRunner({binary=true,code=0,assertArgs=()=>{}}={}) {
  return (command,args,opts)=>{
    assert.equal(command,'docker');
    assert.equal(args[0],'run');
    assert.ok(args.includes('--network=none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(args.includes('--security-opt=no-new-privileges'));
    assert.ok(args.includes('--pull=never'));
    assert.equal(opts.shell,false);
    assert.ok(args.includes('--entrypoint=scons'));
    assert.ok(args.includes('platform=linuxbsd'));
    assert.ok(args.includes('target=editor'));
    const staging=binder(args);
    assert.ok(fs.existsSync(path.join(staging,'SConstruct')));
    assertArgs(args);
    if(binary){
      fs.mkdirSync(path.join(staging,'bin'),{recursive:true});
      fs.writeFileSync(path.join(staging,'bin','godot.linuxbsd.editor.x86_64'),
        Buffer.from('FAKE TEST BINARY (NOT ACTUAL GODOT)'));
    }
    return {status:code,stdout:'scons finished',stderr:'',signal:null};
  };
}

test('Engine SCons compile gate requires successful exit and a nonempty editor binary',()=>{
  const f=fixture();
  try{
    exportProject(f.source,f.bundle);
    const out=validateEngineBundle(f.bundle,{image:'trusted/godot-scons:4.x',
      runner:buildRunner({assertArgs:args=>{
        assert.equal(args.includes('-j2'),true);
        assert.equal(args.filter(x=>x==='--mount').length,1);
      }})});
    assert.equal(out.ok,true);
    assert.equal(out.builds.length,1);
    assert.match(out.builds[0].sha256,/^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(path.join(f.source,'bin')),false);
    assert.equal(fs.existsSync(f.bundle),true);
  }finally{destroy(f);}
});

test('SCons success without binary fails closed',()=>{
  const f=fixture();
  try{
    exportProject(f.source,f.bundle);
    const out=validateEngineBundle(f.bundle,{image:'local/scons:latest',
      runner:buildRunner({binary:false})});
    assert.equal(out.ok,false);
    assert.match(out.error,/No nonempty Godot editor binary/);
    assert.equal(out.exitCode,0);
  }finally{destroy(f);}
});

test('Nonzero compile exit blocks acceptance even when output files exist',()=>{
  const f=fixture();
  try{
    exportProject(f.source,f.bundle);
    const out=validateEngineBundle(f.bundle,{image:'local/scons:latest',
      runner:buildRunner({code:1})});
    assert.equal(out.ok,false);
    assert.equal(out.exitCode,1);
  }finally{destroy(f);}
});

test('Engine gate switches live revision only after successful staged binary verification',()=>{
  const f=fixture();
  try{
    const old=scanProject(f.source,f.state);
    fs.writeFileSync(path.join(f.source,'scene','main.cpp'),'void Engine::boot() { test(1); }\n');
    assert.throws(()=>scanProject(f.source,f.state,{
      engineBuildImage:'trusted/scons:4',
      validationRunner:buildRunner({binary:false})
    }),/validation rejected candidate/);
    assert.equal(current(f).revision,old.revision);
    const out=scanProject(f.source,f.state,{
      engineBuildImage:'trusted/scons:4',
      validationRunner:buildRunner()
    });
    assert.equal(out.validated,true);
    assert.equal(out.validator,'docker-godot-linuxbsd-editor-build');
    assert.equal(liveStatus(f.state,{verify:true}).verified,3);
    assert.equal(current(f).previous.revision,old.revision);
  }finally{destroy(f);}
});

test('Godot scene gate imports then runs only an explicitly packaged smoke scene',()=>{
  const f=fixture('game');
  try {
    exportProject(f.source,f.bundle);
    let n=0;
    const report=validateGodotBundle(f.bundle,{
      image:'trusted/godot:4',
      smokeScene:'res://tests/smoke.tscn',
      runner:(bin,args,opts)=>{
        n++;
        assert.equal(bin,'docker');
        assert.equal(opts.shell,false);
        assert.ok(args.includes('--network=none'));
        assert.ok(args.includes('--pull=never'));
        if(n===1) assert.ok(args.includes('--import'));
        else {
          assert.equal(args.includes('--import'),false);
          assert.ok(args.includes('--quit-after'));
          assert.deepEqual(args.slice(-2),['--scene','res://tests/smoke.tscn']);
        }
        return {status:0,stdout:'Godot launched',stderr:''};
      }
    });
    assert.equal(n,2);
    assert.equal(report.ok,true);
    assert.equal(report.smoke?.ok,true);
    assert.equal(report.smoke.scene,'res://tests/smoke.tscn');
  }finally{destroy(f);}
});

test('Scene runtime errors reject the candidate without promoting live pointer',()=>{
  const f=fixture('game');
  try{
    const old=scanProject(f.source,f.state);
    let called=0;
    assert.throws(()=>scanProject(f.source,f.state,{
      validateImage:'trusted/godot:4',smokeScene:'res://tests/smoke.tscn',
      validationRunner:(_bin,args)=>{
        called++;
        return args.includes('--import')?
          {status:0,stdout:'imports okay',stderr:''}:
          {status:0,stdout:'SCRIPT ERROR: test assertion failed',stderr:''};
      }
    }),/validation rejected candidate/);
    assert.equal(called,2);
    assert.equal(current(f).revision,old.revision);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'last-validation.json'),'utf8')).smoke.ok,false);
  }finally{destroy(f);}
});

test('Rejects unlisted scene, traversal and wrong file kind before Docker launch',()=>{
  const f=fixture('game');
  try{
    exportProject(f.source,f.bundle);
    for(const smokeScene of ['res://missing.tscn','res://../escape.tscn',
      'res://project.godot','/outside/test.tscn']){
      assert.throws(()=>validateGodotBundle(f.bundle,{
        image:'trusted/godot:4',smokeScene,
        runner:()=>{throw Error('Docker must not run');}
      }),/Smoke scene|Unsafe relative path/i);
    }
  }finally{destroy(f);}
});

test('Build validator refuses game projects and validates jobs/timeouts',()=>{
  const f=fixture('game');
  try{
    exportProject(f.source,f.bundle);
    assert.throws(()=>validateEngineBundle(f.bundle,{image:'trusted/scons:4',
      runner:()=>{throw Error('unexpected Docker');}}),/Godot Engine C\+\+ source/);
    assert.throws(()=>validateEngineBundle(f.bundle,{image:'trusted/scons:4',
      jobs:0}),/Build jobs/);
    assert.throws(()=>validateEngineBundle(f.bundle,{image:'trusted/scons:4',
      timeoutMs:500}),/Build timeout/);
  }finally{destroy(f);}
});

test('Smoke mode without a validation image and ambiguous validator selection are refused',()=>{
  const f=fixture('game');
  try{
    assert.throws(()=>scanProject(f.source,f.state,{smokeScene:'res://tests/smoke.tscn'}),
      /requires validateImage/);
    assert.throws(()=>scanProject(f.source,f.state,{
      engineBuildImage:'local/scons:4',validateImage:'local/godot:4'
    }),/only one validation mode/);
    assert.equal(fs.existsSync(path.join(f.state,'current.json')),false);
  }finally{destroy(f);}
});
