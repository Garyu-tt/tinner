'use strict';
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');
const { analyzeBoundaries } = require('./semantic');

const FORMAT = 'tinner.chunkset.v1';
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const lines = source => source ? source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean) : [];

function splitSource(source, opts = {}) {
  if (typeof source !== 'string') throw new TypeError('Expected UTF-8 source string');
  const max = Number(opts.maxLines === undefined ? 2000 : opts.maxLines);
  if (!Number.isInteger(max) || max < 1 || max > 2000) throw new RangeError('maxLines must be 1..2000');
  const filename = path.basename(opts.filename || 'source.txt');
  const ext = path.extname(filename).toLowerCase();
  const language = ({'.js':'javascript','.mjs':'javascript','.cjs':'javascript','.ts':'typescript','.py':'python','.rs':'rust','.cpp':'cpp','.c':'c'})[ext] || 'text';
  const sourceLines = lines(source);
  let analysis = { status: 'not-applicable', reason: 'unsupported-language' };
  if (opts.semantic !== false && language === 'javascript') {
    analysis = analyzeBoundaries(source, sourceLines, filename);
  } else if (opts.semantic === false) {
    analysis = { status: 'disabled' };
  }
  const boundaryLines = analysis.boundaries || [];
  const chunks = [];
  let cursor = 0;
  for (let offset = 0; offset < sourceLines.length;) {
    const limit = Math.min(offset + max, sourceLines.length);
    let end = limit;
    if (limit < sourceLines.length && boundaryLines.length) {
      while (cursor < boundaryLines.length && boundaryLines[cursor] <= offset) cursor++;
      for (let i = cursor; i < boundaryLines.length && boundaryLines[i] <= limit; i++) {
        end = boundaryLines[i];
      }
    }
    const content = sourceLines.slice(offset, end);
    const index = chunks.length;
    const body = content.join('');
    chunks.push({
      id:'part-'+String(index+1).padStart(4,'0'),
      index,startLine:offset+1,endLine:end,
      lineCount:content.length,sha256:sha(body),
      splitReason:end===sourceLines.length?'end-of-file':end!==limit?'top-level-statement':boundaryLines.includes(end)?'top-level-statement':'line-limit',
      source:body
    });
    offset = end;
  }
  if (!chunks.length) chunks.push({id:'part-0001',index:0,startLine:0,endLine:0,lineCount:0,sha256:sha(''),splitReason:'end-of-file',source:''});
  const { boundaries:ignored, detail:parseDiagnostic, ...analysisSummary } = analysis;
  const manifest = {format:FORMAT,filename,language,maxLines:max,lineCount:sourceLines.length,sha256:sha(source),
    analysis:analysisSummary,
    chunks:chunks.map(({source:discard,...meta})=>meta)
  };
  return {manifest,chunks};
}

function joinSource(manifest, parts) {
  if (!manifest || manifest.format !== FORMAT || !Array.isArray(manifest.chunks)) throw new Error('Bad manifest');
  if (!Array.isArray(parts) || parts.length !== manifest.chunks.length) throw new Error('Chunk count mismatch');
  const source = parts.map((part,index) => {
    const meta = manifest.chunks[index];
    const body = typeof part === 'string' ? part : part && part.source;
    if (typeof body !== 'string' || (part && typeof part === 'object' && part.id !== meta.id)) throw new Error('Chunk identity mismatch');
    if (sha(body) !== meta.sha256 || lines(body).length !== meta.lineCount) throw new Error('Chunk integrity mismatch: '+meta.id);
    return body;
  }).join('');
  if (sha(source) !== manifest.sha256 || lines(source).length !== manifest.lineCount) throw new Error('Source integrity mismatch');
  return source;
}

function buildFlow(result) {
  const id = () => randomBytes(8).toString('hex');
  const {manifest,chunks} = result;
  const tab=id(), inject=id(), join=id(), debug=id(), parts=chunks.map(id);
  const nodes=[
    {id:tab,type:'tab',label:'Tinner '+manifest.filename,disabled:false,info:'Source fragments are inert text, not independently executable.'},
    {id:inject,type:'inject',z:tab,name:'Reassemble',props:[{p:'payload'}],repeat:'',once:false,onceDelay:0.1,payload:'',payloadType:'str',x:130,y:80,wires:[[parts[0]]]}
  ];
  chunks.forEach((piece,index)=>nodes.push({id:parts[index],type:'tinner-chunk',z:tab,name:manifest.filename+' '+piece.id,partId:piece.id,index,source:piece.source,x:350+(index%2)*220,y:150+index*65,wires:[[parts[index+1]||join]]}));
  const y=150+chunks.length*65;
  nodes.push({id:join,type:'tinner-join',z:tab,name:'Verify '+manifest.filename,manifest:JSON.stringify(manifest),x:350,y,wires:[[debug]]});
  nodes.push({id:debug,type:'debug',z:tab,name:'Original source',active:true,tosidebar:true,console:false,tostatus:false,complete:'payload',targetType:'msg',x:590,y,wires:[]});
  return nodes;
}
module.exports={splitSource,joinSource,buildFlow,sha,lines};
