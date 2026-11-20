'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {splitSource,joinSource}=require('../lib/tinner');
const {exportProject,verifyProject,restoreProject,referencedPaths}=require('../lib/project');

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-godot-test-'));
  const source=path.join(root,'input');
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(source,'scenes'),{recursive:true});
  fs.mkdirSync(path.join(source,'textures'),{recursive:true});
  fs.mkdirSync(path.join(source,'.godot','imported'),{recursive:true});
  fs.mkdirSync(path.join(source,'.git'),{recursive:true});
  fs.writeFileSync(path.join(source,'project.godot'),'[application]\nconfig/name="TinyTest"\n');
  const script='extends Node2D\n\nfunc move():\n'+Array.from({length:2100},(_,i)=>'    print('+i+')\n').join('')+
    '\nfunc _ready():\n    var next = preload("res://scenes/main.tscn")\n';
  fs.writeFileSync(path.join(source,'scripts','player.gd'),script);
  fs.writeFileSync(path.join(source,'scenes','main.tscn'),'[gd_scene format=3]\n[ext_resource type="Script" path="res://scripts/player.gd" id="1_s"]\n[node name="Root" type="Node2D"]\nscript = ExtResource("1_s")\n');
  fs.writeFileSync(path.join(source,'textures','sprite.png'),Buffer.from([0x89,0x50,0x4e,0x47,0,255,128]));
  fs.writeFileSync(path.join(source,'textures','sprite.png.import'),'[remap]\nimporter="texture"\n');
  fs.writeFileSync(path.join(source,'.godot','imported','generated.ctex'),'cache');
  fs.writeFileSync(path.join(source,'.git','config'),'git-private');
  return {root,source,script};
}
test('Godot GDScript boundary detection ignores fake functions in triple strings',()=>{
  const input='extends Node\nfunc a():\n    var doc = """\nfunc fake():\n    """\n\nfunc b():\n    pass\n';
  const r=splitSource(input,{filename:'player.gd',maxLines:7});
  assert.equal(r.manifest.analysis.parser,'gdscript-lexical');
  assert.equal(joinSource(r.manifest,r.chunks),input);
  assert.ok(r.chunks.every(c=>c.lineCount<=7));
  assert.ok(!r.chunks.some(c=>c.source.startsWith('func fake')));
});
test('Godot project one-command export, verify and restore preserve source and binary',()=>{
  const {root,source,script}=fixture();
  try {
    const bundle=path.join(root,'bundle'),output=path.join(root,'restored');
    const result=exportProject(source,bundle);
    const report=verifyProject(bundle);
    assert.equal(report.verified,5);
    assert.equal(result.manifest.files.some(f=>f.path.includes('.godot')),false);
    assert.equal(result.manifest.files.some(f=>f.path.includes('.git')),false);
    const player=result.manifest.files.find(f=>f.path==='scripts/player.gd');
    assert.ok(player.chunkManifest.chunks.length>1);
    assert.ok(player.chunkManifest.chunks.every(c=>c.lineCount<=2000));
    assert.deepEqual(result.manifest.files.find(f=>f.path==='scenes/main.tscn').dependencies,['scripts/player.gd']);
    assert.ok(fs.existsSync(path.join(bundle,'project-flow.json')));
    const graph=JSON.parse(fs.readFileSync(path.join(bundle,'project-flow.json'),'utf8'));
    const scene=graph.find(n=>n.relativePath==='scenes/main.tscn');
    const playerNode=graph.find(n=>n.relativePath==='scripts/player.gd');
    assert.ok(scene.wires[0].includes(playerNode.id));
    assert.ok(fs.existsSync(path.join(bundle,'flows','scripts','player.gd.json')));
    assert.equal(restoreProject(bundle,output).restored,5);
    assert.equal(fs.readFileSync(path.join(output,'scripts','player.gd'),'utf8'),script);
    assert.deepEqual(fs.readFileSync(path.join(output,'textures','sprite.png')),
      fs.readFileSync(path.join(source,'textures','sprite.png')));
    assert.ok(fs.existsSync(path.join(output,'textures','sprite.png.import')));
    assert.equal(fs.existsSync(path.join(output,'.godot')),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('Rejects tampered bundle chunks and refuses overwrite',()=>{
  const {root,source}=fixture();
  try {
    const bundle=path.join(root,'bundle');
    exportProject(source,bundle);
    assert.throws(()=>exportProject(source,bundle),/exists/);
    fs.appendFileSync(path.join(bundle,'chunks','scripts','player.gd','part-0001.txt'),'CORRUPTED');
    assert.throws(()=>verifyProject(bundle),/integrity mismatch/i);
    const restored=path.join(root,'restored');
    assert.throws(()=>restoreProject(bundle,restored),/integrity mismatch/i);
    assert.equal(fs.existsSync(restored),false);
  } finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Rejects symlinked project entries and archive path traversal',()=>{
  const {root,source}=fixture();
  try{
    const symlink=path.join(source,'link.gd');
    fs.symlinkSync(path.join(source,'scripts','player.gd'),symlink);
    assert.throws(()=>exportProject(source,path.join(root,'bundle')),/Symlink/);
    fs.unlinkSync(symlink);
    const bundle=path.join(root,'bundle');
    exportProject(source,bundle);
    const p=path.join(bundle,'project-manifest.json');
    const manifest=JSON.parse(fs.readFileSync(p,'utf8'));
    manifest.files[0].path='../escape';
    fs.writeFileSync(p,JSON.stringify(manifest));
    assert.throws(()=>verifyProject(bundle),/Unsafe relative path/);
  } finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Static path extraction supports res:// and relative scene ext_resource paths',()=>{
  const r=referencedPaths('[ext_resource path="relative/foo.tres"]\nconst X = preload("res://scripts/a.gd")\n','scenes/a.tscn');
  assert.deepEqual(r.names,['scenes/relative/foo.tres','scripts/a.gd']);
});
test('Invalid UTF8 in source fails safely; no output bundle remains',()=>{
  const {root,source}=fixture();
  try{
    fs.writeFileSync(path.join(source,'scripts','invalid.gd'),Buffer.from([0xc3,0x28]));
    const bundle=path.join(root,'bundle');
    assert.throws(()=>exportProject(source,bundle),/encoded|UTF-8|valid/i);
    assert.equal(fs.existsSync(bundle),false);
  } finally{fs.rmSync(root,{recursive:true,force:true});}
});
