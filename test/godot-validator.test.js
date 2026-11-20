'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {exportProject}=require('../lib/project');
const {validateGodotBundle}=require('../lib/godot-validator');
const {scanProject,liveStatus}=require('../lib/live');

function fixture() {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-validator-test-'));
  const source=path.join(base,'source'),bundle=path.join(base,'bundle'),state=path.join(base,'state');
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(source,'project.godot'),'[application]\nconfig/name="valid"\n');
  fs.writeFileSync(path.join(source,'scripts','main.gd'),
    'extends Node\nfunc main() -> int:\n    return 1\n');
  return {base,source,bundle,state};
}
function clean(f){fs.rmSync(f.base,{recursive:true,force:true});}
const script=f=>path.join(f.source,'scripts','main.gd');
const current=f=>JSON.parse(fs.readFileSync(path.join(f.state,'current.json'),'utf8'));
function successfulRunner(inspect=()=>{}) {
  return (exe,args,opts)=>{
    assert.equal(exe,'docker');
    assert.equal(opts.shell,false);
    assert.equal(args[0],'run');
    assert.ok(args.includes('--network=none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(args.includes('--security-opt=no-new-privileges'));
    assert.ok(args.includes('--pull=never'));
    assert.ok(args.includes('--pids-limit=128'));
    assert.ok(args.includes('--headless'));
    assert.ok(args.includes('--import'));
    assert.ok(!args.includes('--privileged'));
    const mount=args.find(x=>x.startsWith('type=bind,src='));
    assert.ok(mount);
    const sourcePath=mount.slice('type=bind,src='.length).split(',dst=')[0];
    assert.equal(fs.readFileSync(path.join(sourcePath,'scripts','main.gd'),'utf8').includes('return'),true);
    inspect({sourcePath,args,opts});
    return {status:0,stdout:'Godot Engine v4.5\n',stderr:'',signal:null};
  };
}

test('opt-in Docker validation uses an isolated restored copy, not original source',()=>{
  const f=fixture();
  try{
    exportProject(f.source,f.bundle);
    const report=validateGodotBundle(f.bundle,{image:'local/godot:4.5',
      runner:successfulRunner(({sourcePath,args})=>{
        assert.notEqual(sourcePath,f.source);
        assert.notEqual(sourcePath,f.bundle);
        assert.ok(args.indexOf('local/godot:4.5')>args.indexOf('--entrypoint=godot'));
        assert.equal(args.filter(x=>x==='--mount').length,1);
      })});
    assert.equal(report.ok,true);
    assert.equal(report.validator,'docker-godot-import');
    assert.equal(report.exitCode,0);
    assert.equal(fs.existsSync(f.source),true);
  }finally{clean(f);}
});

test('nonzero exit or SCRIPT ERROR blocks publication and preserves accepted revision',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.source,f.state);
    fs.writeFileSync(script(f),'extends Node\nfunc broken(:\n');
    let failures=0;
    assert.throws(()=>scanProject(f.source,f.state,{
      validateImage:'local/godot:4.5',
      validationRunner:()=>{failures++;return {status:0,stdout:'SCRIPT ERROR: Parse Error: unexpected token',stderr:''};}
    }),/Godot validation rejected candidate/);
    assert.equal(failures,1);
    assert.equal(current(f).revision,first.revision);
    assert.equal(fs.readdirSync(path.join(f.state,'revisions')).length,1);
    const report=JSON.parse(fs.readFileSync(path.join(f.state,'last-validation.json'),'utf8'));
    assert.equal(report.ok,false);
    assert.equal(report.revision.startsWith('rev-'),true);
  }finally{clean(f);}
});

test('successful Godot verification gates publication and reports provenance',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.source,f.state);
    fs.writeFileSync(script(f),'extends Node\nfunc main() -> int:\n    return 5\n');
    const next=scanProject(f.source,f.state,{
      validateImage:'registry.example.local/godot:4.5',
      validationRunner:successfulRunner()
    });
    assert.equal(next.status,'updated');
    assert.equal(next.validated,true);
    assert.equal(next.validator,'docker-godot-import');
    assert.equal(current(f).settings.validateImage,'registry.example.local/godot:4.5');
    assert.equal(liveStatus(f.state,{verify:true}).verified,2);
    assert.equal(current(f).previous.revision,first.revision);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'last-validation.json'),'utf8')).ok,true);
  }finally{clean(f);}
});

test('enabling validation on unchanged sources forces a gated revision once',()=>{
  const f=fixture();
  try{
    const first=scanProject(f.source,f.state);
    let checks=0;
    const next=scanProject(f.source,f.state,{
      validateImage:'local/godot:4.5',validationRunner:successfulRunner(()=>checks++)
    });
    assert.equal(next.settingsChanged,true);
    assert.equal(next.changed,0);
    assert.equal(next.validated,true);
    assert.notEqual(next.revision,first.revision);
    assert.equal(checks,1);
    assert.equal(scanProject(f.source,f.state,{
      validateImage:'local/godot:4.5',validationRunner:successfulRunner(()=>checks++)
    }).status,'unchanged');
    assert.equal(checks,1);
  }finally{clean(f);}
});

test('missing image or wrong image references fail closed before running host code',()=>{
  const f=fixture();
  try{
    exportProject(f.source,f.bundle);
    for(const image of ['', '--privileged', 'example//bad','image\n--network=host']) {
      assert.throws(()=>validateGodotBundle(f.bundle,{image,runner:()=>{throw Error('must not run');}}),
        /Docker image reference/i);
    }
    assert.throws(()=>validateGodotBundle(f.bundle,{image:'godot:local',timeoutMs:9}),
      /timeout/i);
  }finally{clean(f);}
});

test('Godot engine C++ checkout cannot be silently mistaken for a runnable game project',()=>{
  const f=fixture();
  try{
    fs.unlinkSync(path.join(f.source,'project.godot'));
    fs.mkdirSync(path.join(f.source,'scene'));
    fs.mkdirSync(path.join(f.source,'core'));
    fs.writeFileSync(path.join(f.source,'SConstruct'),'env=Environment()\n');
    exportProject(f.source,f.bundle);
    assert.throws(()=>validateGodotBundle(f.bundle,{
      image:'godot:4',runner:()=>{throw Error('must not execute');}
    }),/separate compile validator/);
  }finally{clean(f);}
});

test('Docker launch errors and nonzero exits are rejected without publishing',()=>{
  const f=fixture();
  try{
    exportProject(f.source,f.bundle);
    const fail=validateGodotBundle(f.bundle,{
      image:'godot:4.5',runner:()=>({status:null,error:new Error('docker unavailable'),stdout:'',stderr:''})
    });
    assert.equal(fail.ok,false);
    assert.match(fail.error,/docker unavailable/);
    const nonzero=validateGodotBundle(f.bundle,{
      image:'godot:4.5',runner:()=>({status:3,stdout:'',stderr:'Godot import failed'})
    });
    assert.equal(nonzero.ok,false);
    assert.equal(nonzero.exitCode,3);
  }finally{clean(f);}
});
