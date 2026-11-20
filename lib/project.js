'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { splitSource, joinSource, buildFlow } = require('./tinner');

const FORMAT = 'tinner.project.v1';
const CACHE_DIRS = new Set(['.git', '.godot', 'node_modules']);
const TEXT_EXT = new Set([
  '.gd', '.gdshader', '.gdshaderinc', '.tscn', '.tres', '.godot',
  '.cfg', '.ini', '.import', '.json', '.js', '.mjs', '.cjs',
  '.ts', '.py', '.cs', '.rs', '.cpp', '.c', '.h', '.hpp',
  '.md', '.txt', '.csv', '.xml', '.yaml', '.yml', '.toml',
  '.shader', '.glsl', '.gitignore', '.gitattributes'
]);
const GRAPH_CODE_EXT = new Set(['.gd', '.gdshader', '.js', '.mjs', '.cjs', '.ts', '.py', '.cs']);
const digest = buf => crypto.createHash('sha256').update(buf).digest('hex');
const stableId = value => crypto.createHash('sha256').update(value).digest('hex').slice(0,16);

function normalizedRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.includes('\0') || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) {
    throw new Error('Unsafe relative path');
  }
  const segments = relative.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe relative path');
  return relative;
}
function fileAt(root, relative) {
  const rel = normalizedRelative(relative);
  const target = path.resolve(root, ...rel.split('/'));
  if (!target.startsWith(path.resolve(root)+path.sep)) throw new Error('Artifact path escape');
  // Never follow a symlink in externally supplied bundles.
  let current = path.resolve(root);
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink in bundle: '+rel);
  }
  if (!fs.statSync(target).isFile()) throw new Error('Not a file: '+rel);
  return fs.readFileSync(target);
}
function writeNew(root, relative, bytes) {
  const rel = normalizedRelative(relative);
  const target = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, bytes, {flag:'wx'});
}
function strictUTF8(buffer) {
  return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(buffer);
}
function enumerate(root) {
  const result = [];
  const ignored = [];
  function walk(dir, prefix) {
    for (const item of fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const rel = prefix ? prefix+'/'+item.name : item.name;
      normalizedRelative(rel);
      if (item.isSymbolicLink()) throw new Error('Symlink not supported: '+rel);
      if (item.isDirectory()) {
        if (CACHE_DIRS.has(item.name)) { ignored.push(rel+'/'); continue; }
        walk(path.join(dir,item.name),rel);
      } else if (item.isFile()) result.push(rel);
      else throw new Error('Unsupported project entry: '+rel);
    }
  }
  walk(root,'');
  return {result:result.sort(),ignored};
}
function kindOf(rel) {
  const ext=path.posix.extname(rel).toLowerCase();
  if (ext === '.gd') return 'gdscript';
  if (ext === '.tscn') return 'scene';
  if (ext === '.tres') return 'resource';
  if (ext === '.gdshader' || ext === '.shader') return 'shader';
  if (rel === 'project.godot') return 'project-settings';
  if (GRAPH_CODE_EXT.has(ext)) return 'code';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'asset';
}
function referencedPaths(text, rel) {
  const names = new Set();
  const unresolved = new Set();
  function add(p) {
    let candidate;
    if (p.startsWith('res://')) candidate = p.slice(6);
    else candidate = path.posix.join(path.posix.dirname(rel),p);
    candidate = path.posix.normalize(candidate);
    try { normalizedRelative(candidate); names.add(candidate); }
    catch { unresolved.add(p); }
  }
  // Static quoted res:// paths (not a GDScript dynamic evaluator).
  const all = /(["'])res:\/\/([^"'\r\n]+)\1/g;
  for (const match of text.matchAll(all)) add('res://'+match[2]);
  // Godot's text scene/resource format also permits relative paths in ext_resource.
  if (/\.(tscn|tres)$/i.test(rel)) {
    const external = /\[ext_resource\b[^\r\n\]]*\bpath=(["'])([^"'\r\n]+)\1/g;
    for (const match of text.matchAll(external)) add(match[2]);
  }
  return {names:[...names].sort(),unresolved:[...unresolved].sort()};
}
function buildProjectFlow(manifest) {
  const tab = stableId('tinner-project-tab');
  const idFor = rel => stableId('tinner-module:'+rel);
  const available = new Set(manifest.files.map(file=>file.path));
  const nodes = [{
    id:tab, type:'tab', label:'Tinner · Godot project', disabled:false,
    info:'Read-only structural visualization. Dependency wires are inert; code does not execute.'
  }];
  manifest.files.forEach((file,i)=>{
    const dependencies = (file.dependencies||[]).filter(dep=>available.has(dep));
    nodes.push({
      id:idFor(file.path), type:'tinner-project-module', z:tab,
      name:path.posix.basename(file.path), relativePath:file.path,
      kind:file.kind, sha256:file.sha256,
      dependencyList:JSON.stringify(dependencies),
      inputs:1, outputs:1,
      x:250+(i%4)*260, y:100+Math.floor(i/4)*90,
      wires:[dependencies.map(idFor)]
    });
  });
  return nodes;
}
function verifyProject(bundle) {
  const root=fs.realpathSync(bundle);
  const manifest=JSON.parse(fileAt(root,'project-manifest.json').toString('utf8'));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files)) throw new Error('Invalid project manifest');
  const seen=new Set();
  for (const entry of manifest.files) {
    normalizedRelative(entry.path);
    if (seen.has(entry.path)) throw new Error('Duplicate project path');
    seen.add(entry.path);
    let data;
    if (entry.storage === 'chunks') {
      if (!entry.chunkManifest || !Array.isArray(entry.chunkManifest.chunks)) throw new Error('No chunk manifest');
      const parts=entry.chunkManifest.chunks.map((part,index)=>{
        const id='part-'+String(index+1).padStart(4,'0');
        if (part.id!==id) throw new Error('Bad part order');
        const location='chunks/'+entry.path+'/'+id+'.txt';
        return {id,source:strictUTF8(fileAt(root,location))};
      });
      data=Buffer.from(joinSource(entry.chunkManifest,parts),'utf8');
    } else if (entry.storage === 'binary') {
      data=fileAt(root,'assets/'+entry.path);
    } else throw new Error('Unsupported storage mode');
    if (data.length!==entry.bytes || digest(data)!==entry.sha256) throw new Error('Project hash mismatch: '+entry.path);
  }
  if (!seen.has('project.godot')) throw new Error('Missing project.godot');
  return {manifest, verified:seen.size};
}
function exportProject(input, output, options={}) {
  const root=fs.realpathSync(input);
  if (!fs.statSync(root).isDirectory() || !fs.statSync(path.join(root,'project.godot')).isFile()) {
    throw new Error('A Godot directory containing project.godot is required');
  }
  const target=path.resolve(output);
  if (fs.existsSync(target)) throw new Error('Output exists; refusing overwrite');
  if (target===root || target.startsWith(root+path.sep)) throw new Error('Output must be outside input project');
  const maxLines=options.maxLines===undefined?2000:Number(options.maxLines);
  if (!Number.isInteger(maxLines)||maxLines<1||maxLines>2000) throw new Error('maxLines must be 1..2000');
  const limit=options.maxTextBytes===undefined?16*1024*1024:options.maxTextBytes;
  if (!Number.isSafeInteger(limit)||limit<1) throw new Error('Invalid maxTextBytes');
  const {result:files,ignored}=enumerate(root);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  const temporary=fs.mkdtempSync(path.join(path.dirname(target),'.tinner-build-'));
  let completed=false;
  try {
    const entries=[];
    const extracted=new Map();
    for (const rel of files) {
      const data=fs.readFileSync(path.join(root,...rel.split('/')));
      const ext=path.posix.extname(rel).toLowerCase();
      const kind=kindOf(rel);
      const entry={path:rel,kind,bytes:data.length,sha256:digest(data)};
      if (TEXT_EXT.has(ext) || rel==='project.godot') {
        if (data.length>limit) throw new Error('Text file exceeds maxTextBytes: '+rel);
        const source=strictUTF8(data);
        const chunks=splitSource(source,{filename:path.posix.basename(rel),maxLines,semantic:true});
        entry.storage='chunks';
        entry.chunkManifest=chunks.manifest;
        extracted.set(rel,source);
        for (const part of chunks.chunks) {
          writeNew(temporary,'chunks/'+rel+'/'+part.id+'.txt',Buffer.from(part.source,'utf8'));
        }
        if (GRAPH_CODE_EXT.has(ext)) {
          writeNew(temporary,'flows/'+rel+'.json',
            JSON.stringify(buildFlow(chunks),null,2)+'\n');
        }
      } else {
        entry.storage='binary';
        writeNew(temporary,'assets/'+rel,data);
      }
      entries.push(entry);
    }
    const existing=new Set(entries.map(e=>e.path));
    for (const entry of entries) {
      if (entry.storage !== 'chunks') continue;
      const found=referencedPaths(extracted.get(entry.path),entry.path);
      entry.dependencies=found.names.filter(ref=>existing.has(ref));
      entry.unresolved=[...found.unresolved,...found.names.filter(ref=>!existing.has(ref))].sort();
    }
    const manifest={format:FORMAT,tool:'tinner',mode:'godot',maxLines,
      ignoredCacheDirectories:ignored,files:entries,
      graphSemantics:'reference-only (no executable dependency edges)'};
    writeNew(temporary,'project-manifest.json',JSON.stringify(manifest,null,2)+'\n');
    writeNew(temporary,'project-flow.json',JSON.stringify(buildProjectFlow(manifest),null,2)+'\n');
    verifyProject(temporary);
    if (fs.existsSync(target)) throw new Error('Output appeared during build');
    fs.renameSync(temporary,target);
    completed=true;
    return {manifest,output:target};
  } finally {
    if (!completed) fs.rmSync(temporary,{recursive:true,force:true});
  }
}
function restoreProject(bundle, output) {
  const {manifest}=verifyProject(bundle);
  const root=fs.realpathSync(bundle);
  const target=path.resolve(output);
  if (fs.existsSync(target)) throw new Error('Restore target exists; refusing overwrite');
  if (target===root || target.startsWith(root+path.sep)) throw new Error('Restore target must be outside bundle');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=fs.mkdtempSync(path.join(path.dirname(target),'.tinner-restore-'));
  let completed=false;
  try {
    for (const entry of manifest.files) {
      let data;
      if (entry.storage === 'binary') {
        data=fileAt(root,'assets/'+entry.path);
      } else {
        const parts=entry.chunkManifest.chunks.map((part,index)=>{
          const id='part-'+String(index+1).padStart(4,'0');
          return {id,source:strictUTF8(fileAt(root,'chunks/'+entry.path+'/'+id+'.txt'))};
        });
        data=Buffer.from(joinSource(entry.chunkManifest,parts),'utf8');
      }
      if (data.length!==entry.bytes||digest(data)!==entry.sha256) throw new Error('Hash mismatch during restore');
      writeNew(temporary,entry.path,data);
    }
    if (fs.existsSync(target)) throw new Error('Restore target appeared during build');
    fs.renameSync(temporary,target);
    completed=true;
    return {output:target,restored:manifest.files.length};
  } finally {
    if (!completed) fs.rmSync(temporary,{recursive:true,force:true});
  }
}
module.exports={exportProject,verifyProject,restoreProject,buildProjectFlow,referencedPaths,normalizedRelative};
