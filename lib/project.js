'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { splitSource, joinSource, buildFlow } = require('./tinner');
const { indexSourceSymbols, buildSymbolGraph, buildSymbolFlow } = require('./symbols');

const FORMAT = 'tinner.project.v1';
const CACHE_DIRS = new Set(['.git', '.godot', 'node_modules']);
const TEXT_EXT = new Set([
  '.gd', '.gdshader', '.gdshaderinc', '.tscn', '.tres', '.godot',
  '.cfg', '.ini', '.import', '.json', '.js', '.mjs', '.cjs',
  '.ts', '.py', '.cs', '.rs', '.cpp', '.c', '.h', '.hpp',
  '.md', '.txt', '.csv', '.xml', '.yaml', '.yml', '.toml',
  '.shader', '.glsl', '.gitignore', '.gitattributes',
  '.inl', '.inc', '.hh', '.hxx', '.cc', '.mm', '.m', '.scons', '.pyi'
]);
const GRAPH_CODE_EXT = new Set(['.gd', '.gdshader', '.js', '.mjs', '.cjs', '.ts', '.py', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.hxx', '.hh', '.inl', '.mm', '.m']);
const BUILD_SCRIPTS = new Set(['SConstruct', 'SCsub', 'SConscript', 'Makefile', 'CMakeLists.txt']);
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
function fileDigest(sourceFile) {
  const hash=crypto.createHash('sha256');
  const fd=fs.openSync(sourceFile,'r');
  const buffer=Buffer.allocUnsafe(1024*1024);
  let bytes=0;
  try {
    for (;;) {
      const count=fs.readSync(fd,buffer,0,buffer.length,null);
      if(!count) break;
      bytes+=count;
      hash.update(buffer.subarray(0,count));
    }
  } finally { fs.closeSync(fd); }
  return {bytes,sha256:hash.digest('hex')};
}
function copyNew(root,relative,sourceFile) {
  const target=path.join(root,...normalizedRelative(relative).split('/'));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(sourceFile,target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
}
// A reusable artifact must be verified inside a prior bundle. Unlike plain
// copyFileSync, this rejects symlinks on every path component.
function copyStored(previousRoot,temporary,relative) {
  normalizedRelative(relative);
  let current=path.resolve(previousRoot);
  for(const part of relative.split('/')) {
    current=path.join(current,part);
    const stat=fs.lstatSync(current);
    if(stat.isSymbolicLink()) throw new Error('Symlink in previous bundle: '+relative);
  }
  if(!fs.statSync(current).isFile()) throw new Error('Not a stored file: '+relative);
  copyNew(temporary,relative,current);
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
  if (GRAPH_CODE_EXT.has(ext) || BUILD_SCRIPTS.has(path.posix.basename(rel))) return 'code';
  if (TEXT_EXT.has(ext) || BUILD_SCRIPTS.has(path.posix.basename(rel))) return 'text';
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
  // Godot engine C/C++: include paths are either repo-root-relative or
  // relative to the including file. Resolution against actual files is below.
  const includes=[...text.matchAll(/^\s*#\s*include\s+"([^"\r\n]+)"/gm)].map(match=>match[1]);
  return {names:[...names].sort(),unresolved:[...unresolved].sort(),includes};
}
function buildProjectFlow(manifest) {
  const scope=manifest.projectNamespace||'legacy';
  const tab = stableId('tinner-project-tab:'+scope);
  const idFor = rel => stableId('tinner-module:'+scope+':'+rel);
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
  if (manifest.mode === 'godot-engine') {
    if (!seen.has('SConstruct')) throw new Error('Missing Godot SConstruct');
  } else if (!seen.has('project.godot')) throw new Error('Missing project.godot');
  if (manifest.generatedArtifacts !== undefined) {
    if (!Array.isArray(manifest.generatedArtifacts)) throw new Error('Invalid generated artifact list');
    const seenArtifacts=new Set();
    for (const item of manifest.generatedArtifacts) {
      normalizedRelative(item.path);
      if (seenArtifacts.has(item.path)) throw new Error('Duplicate generated artifact');
      seenArtifacts.add(item.path);
      if (!(item.path === 'project-flow.json' || item.path === 'symbol-graph.json' ||
            item.path.startsWith('flows/'))) throw new Error('Unexpected generated artifact path');
      const data=fileAt(root,item.path);
      if (data.length !== item.bytes || digest(data) !== item.sha256) {
        throw new Error('Generated graph integrity mismatch: '+item.path);
      }
    }
  }
  return {manifest, verified:seen.size};
}
function exportProject(input, output, options={}) {
  const root=fs.realpathSync(input);
  const hasFile = name => {
    try {return fs.statSync(path.join(root,name)).isFile();}
    catch {return false;}
  };
  const hasDir = name => {
    try {return fs.statSync(path.join(root,name)).isDirectory();}
    catch {return false;}
  };
  const mode = hasFile('project.godot') ? 'godot-game' :
    hasFile('SConstruct') && hasDir('core') && hasDir('scene') ? 'godot-engine' : null;
  if (!fs.statSync(root).isDirectory() || !mode)
    throw new Error('Expected Godot game project (project.godot) or engine source (SConstruct + core/ + scene/)');
  const projectNamespace=mode+':'+(options.namespace||path.basename(root));
  if (typeof projectNamespace!=='string'||projectNamespace.length>300) throw new Error('Invalid project namespace');
  const target=path.resolve(output);
  if (fs.existsSync(target)) throw new Error('Output exists; refusing overwrite');
  if (target===root || target.startsWith(root+path.sep)) throw new Error('Output must be outside input project');
  const maxLines=options.maxLines===undefined?2000:Number(options.maxLines);
  if (!Number.isInteger(maxLines)||maxLines<1||maxLines>2000) throw new Error('maxLines must be 1..2000');
  const limit=options.maxTextBytes===undefined?16*1024*1024:options.maxTextBytes;
  if (!Number.isSafeInteger(limit)||limit<1) throw new Error('Invalid maxTextBytes');
  // Caller supplies a trusted metadata delta. Changed paths are always parsed.
  // Files outside that delta may reuse verified chunks, binary assets and the
  // stored syntax index. Legacy bundles without an index are rebuilt once.
  if (!!options.baselineBundle !== Array.isArray(options.changedPaths))
    throw new Error('Reuse requires both baselineBundle and changedPaths');
  let previous=null,previousRoot=null,changed=new Set();
  if(options.baselineBundle) {
    previousRoot=fs.realpathSync(options.baselineBundle);
    if(previousRoot===root || previousRoot.startsWith(root+path.sep))
      throw new Error('Baseline bundle must be outside project source');
    const checked=verifyProject(previousRoot);
    previous=checked.manifest;
    if(previous.mode!==mode || previous.projectNamespace!==projectNamespace || previous.maxLines!==maxLines)
      throw new Error('Incompatible baseline bundle (mode, namespace or maxLines)');
    changed=new Set(options.changedPaths.map(normalizedRelative));
  }
  const priorFiles=new Map((previous?.files||[]).map(entry=>[entry.path,entry]));
  const priorArtifacts=new Set((previous?.generatedArtifacts||[]).map(item=>item.path));
  const {result:files,ignored}=enumerate(root);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  const temporary=fs.mkdtempSync(path.join(path.dirname(target),'.tinner-build-'));
  let completed=false;
  try {
    const entries=[];
    const symbolEntries=[];
    const generatedPaths=[];
    const pathsKnown=new Set(files);
    let reusedFiles=0,processedFiles=0;
    for (const rel of files) {
      const sourceFile=path.join(root,...rel.split('/'));
      const ext=path.posix.extname(rel).toLowerCase();
      const kind=kindOf(rel);
      const isText=TEXT_EXT.has(ext)||rel==='project.godot'||BUILD_SCRIPTS.has(path.posix.basename(rel));
      const cached=priorFiles.get(rel);
      const shouldReuse=!!cached && !changed.has(rel) &&
        cached.storage===(isText?'chunks':'binary') &&
        (!isText || (cached.references && cached.symbolIndexEntry &&
          (!GRAPH_CODE_EXT.has(ext) && !BUILD_SCRIPTS.has(path.posix.basename(rel)) ||
          priorArtifacts.has('flows/'+rel+'.json'))));
      if(shouldReuse) {
        const entry=JSON.parse(JSON.stringify(cached));
        if(isText) {
          entry._references=entry.references;
          if(entry.symbolIndexEntry.status!=='unsupported')
            symbolEntries.push({file:rel,...entry.symbolIndexEntry});
          for(const part of entry.chunkManifest.chunks)
            copyStored(previousRoot,temporary,'chunks/'+rel+'/'+part.id+'.txt');
          if(GRAPH_CODE_EXT.has(ext) || BUILD_SCRIPTS.has(path.posix.basename(rel))) {
            const flowPath='flows/'+rel+'.json';
            copyStored(previousRoot,temporary,flowPath);
            generatedPaths.push(flowPath);
          }
        } else {
          copyStored(previousRoot,temporary,'assets/'+rel);
        }
        entries.push(entry);
        reusedFiles++;
        continue;
      }
      processedFiles++;
      if (isText && fs.statSync(sourceFile).size>limit) throw new Error('Text file exceeds maxTextBytes: '+rel);
      const data=isText?fs.readFileSync(sourceFile):null;
      const summary=data?{bytes:data.length,sha256:digest(data)}:fileDigest(sourceFile);
      const entry={path:rel,kind,...summary};
      if (isText) {
        const source=strictUTF8(data);
        const chunks=splitSource(source,{filename:path.posix.basename(rel),maxLines,semantic:true});
        entry.storage='chunks';
        entry.chunkManifest=chunks.manifest;
        entry.references=referencedPaths(source,rel);
        entry._references=entry.references;
        const symbols=indexSourceSymbols(source,rel);
        entry.symbolIndexEntry=symbols;
        if (symbols.status!=='unsupported') symbolEntries.push({file:rel,...symbols});
        for (const part of chunks.chunks) {
          writeNew(temporary,'chunks/'+rel+'/'+part.id+'.txt',Buffer.from(part.source,'utf8'));
        }
        if (GRAPH_CODE_EXT.has(ext) || BUILD_SCRIPTS.has(path.posix.basename(rel))) {
          const flowPath='flows/'+rel+'.json';
          writeNew(temporary,flowPath,JSON.stringify(buildFlow(chunks,{stableKey:projectNamespace+':'+rel}),null,2)+'\n');
          generatedPaths.push(flowPath);
        }
      } else {
        entry.storage='binary';
        copyNew(temporary,'assets/'+rel,sourceFile);
      }
      entries.push(entry);
    }
    const existing=pathsKnown;
    for (const entry of entries) {
      if (entry.storage !== 'chunks') continue;
      const found=entry._references;
      delete entry._references;
      const deps=new Set(found.names.filter(ref=>existing.has(ref)));
      const missing=new Set([...found.unresolved,...found.names.filter(ref=>!existing.has(ref))]);
      for (const include of found.includes) {
        const candidateRoot=path.posix.normalize(include);
        const candidateLocal=path.posix.normalize(path.posix.join(path.posix.dirname(entry.path),include));
        const chosen=[candidateRoot,candidateLocal].find(p=>{
          try { return normalizedRelative(p) && existing.has(p); }
          catch { return false; }
        });
        if (chosen) deps.add(chosen);
        else missing.add(include);
      }
      entry.dependencies=[...deps].sort();
      entry.unresolved=[...missing].sort();
    }
    const symbolGraph=buildSymbolGraph(symbolEntries);
    writeNew(temporary,'symbol-graph.json',JSON.stringify(symbolGraph,null,2)+'\n');
    generatedPaths.push('symbol-graph.json');
    for (const indexed of symbolEntries) {
      if (!indexed.symbols.length) continue;
      const filePath='flows/symbols/'+indexed.file+'.json';
      writeNew(temporary,filePath,JSON.stringify(buildSymbolFlow(symbolGraph,indexed.file,projectNamespace),null,2)+'\n');
      generatedPaths.push(filePath);
    }
    const projectFlow=buildProjectFlow({files:entries,projectNamespace});
    writeNew(temporary,'project-flow.json',JSON.stringify(projectFlow,null,2)+'\n');
    generatedPaths.push('project-flow.json');
    const generatedArtifacts=generatedPaths.sort().map(file=>{
      const bytes=fileAt(temporary,file);
      return {path:file,bytes:bytes.length,sha256:digest(bytes)};
    });
    const manifest={format:FORMAT,tool:'tinner',mode,projectNamespace,maxLines,
      ignoredCacheDirectories:ignored,files:entries,generatedArtifacts,
      symbolIndex:{format:symbolGraph.format,functions:symbolGraph.symbols.length,possibleCallEdges:symbolGraph.edges.length,filesIndexed:symbolEntries.length},
      incremental:{mode:previous?'baseline-reuse':'full',reusedFiles,processedFiles},
      graphSemantics:'reference-only (no executable dependency edges)'};
    writeNew(temporary,'project-manifest.json',JSON.stringify(manifest,null,2)+'\n');

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
module.exports={exportProject,verifyProject,restoreProject,buildProjectFlow,referencedPaths,normalizedRelative,enumerate};
