'use strict';

// Deterministic nested reference-only Universal Graph IR from verified Tinner
// archives. Directories become graph containers, file types reusable
// definitions, source files instances, and imports non-executable metadata.
const crypto=require('node:crypto');
const path=require('node:path');
const {verifyProject}=require('./project');
const {FORMAT,compileGraph}=require('./graph-manager');

const stable=(kind,scope,relative)=>kind+'-'+crypto.createHash('sha256')
  .update(scope+'\0'+relative).digest('hex').slice(0,20);
function fromBundle(bundle,{revision='bundle'}={}){
  const {manifest}=verifyProject(bundle);
  if(!manifest||!Array.isArray(manifest.files))throw Error('Invalid Tinner project manifest');
  const namespace=manifest.projectNamespace;
  if(typeof namespace!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(namespace))
    throw Error('Project namespace is not compatible with Universal Graph IR');
  const dirs=new Set(['.']),files=new Map();
  for(const entry of manifest.files){
    const segments=entry.path.split('/');
    files.set(entry.path,entry);
    for(let i=1;i<segments.length;i++)dirs.add(segments.slice(0,i).join('/'));
  }
  const sortedDirs=[...dirs].sort(),sortedFiles=[...files.keys()].sort();
  const gid=directory=>stable('graph',namespace,directory);
  const nid=relative=>stable('node',namespace,relative);
  const kinds=[...new Set(manifest.files.map(e=>e.kind))].sort();
  const definitions=kinds.map(kind=>({
    id:'tinner.'+kind,version:1,kind:'reference',inputs:[],outputs:[]
  }));
  const graphs=sortedDirs.map(dir=>({id:gid(dir),inputs:[],outputs:[],nodes:[],connections:[]}));
  const graphByDir=new Map(sortedDirs.map((dir,i)=>[dir,graphs[i]]));
  for(const dir of sortedDirs){
    if(dir==='.')continue;
    const parent=path.posix.dirname(dir);
    graphByDir.get(parent==='.'?'.':parent).nodes.push({
      id:nid('container/'+dir),graphRef:gid(dir),label:path.posix.basename(dir)
    });
  }
  const fileIds=new Map();
  for(const file of sortedFiles){
    const entry=files.get(file),directory=path.posix.dirname(file);
    const id=nid('file/'+file);
    fileIds.set(file,id);
    graphByDir.get(directory).nodes.push({
      id,definition:'tinner.'+entry.kind+'@1',label:path.posix.basename(file),
      source:{path:file,kind:entry.kind,sha256:entry.sha256,bytes:entry.bytes}
    });
  }
  for(const graph of graphs)graph.nodes.sort((a,b)=>a.id.localeCompare(b.id,'en'));
  const dependencies=[];
  for(const file of sortedFiles){
    const entry=files.get(file);
    for(const dep of entry.dependencies||[]){
      if(!fileIds.has(dep))throw Error('Manifest dependency not found: '+dep);
      dependencies.push({from:fileIds.get(file),to:fileIds.get(dep),kind:'file-reference'});
    }
  }
  dependencies.sort((a,b)=>a.from.localeCompare(b.from,'en')||a.to.localeCompare(b.to,'en'));
  const ir={
    format:FORMAT,namespace,revision,root:gid('.'),
    definitions,graphs,dependencies,exports:[],
    source:{format:manifest.format,mode:manifest.mode,files:manifest.files.length}
  };
  // Validate IR before returning so no unresolvable directory or path escapes.
  compileGraph(ir);
  return ir;
}
module.exports={fromBundle};
