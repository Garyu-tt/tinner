'use strict';

// Conservative lexical symbol indexing: metadata only. Never eval(), require()
// or compile code received from a project. These are heuristic call edges, not
// a substitute for Godot's parser, a C++ compiler, or a language server.
const { createHash } = require('node:crypto');
const path = require('node:path');
const ID = value => createHash('sha256').update(value).digest('hex').slice(0,20);
const NAME = /^[A-Za-z_][A-Za-z_0-9]*$/;

function mask(source, language) {
  const gd = language === 'gdscript';
  let output = '';
  let string = null, blockComment = false, escaped = false, lineComment = false;
  for (let i=0; i<source.length;) {
    const c = source[i];
    if (c==='\r' || c==='\n') {
      output+=c; i++;
      lineComment = false;
      if (string && string.length === 1) {string=null;escaped=false;}
      continue;
    }
    if (lineComment) {output+=' ';i++;continue;}
    if (blockComment) {
      if (source.slice(i,i+2)==='*/') {output+='  ';i+=2;blockComment=false;}
      else {output+=' ';i++;}
      continue;
    }
    if (string) {
      if (string.length===3 && source.slice(i,i+3)===string) {
        output+='   ';i+=3;string=null;continue;
      }
      if (string.length===1) {
        if (!escaped && c==='\\') escaped=true;
        else {
          if (!escaped && c===string) string=null;
          escaped=false;
        }
      }
      output+=' ';i++;continue;
    }
    if (gd && c==='#') {lineComment=true;output+=' ';i++;continue;}
    if (!gd && source.slice(i,i+2)==='//') {lineComment=true;output+='  ';i+=2;continue;}
    if (!gd && source.slice(i,i+2)==='/*') {blockComment=true;output+='  ';i+=2;continue;}
    if (c==='"'||c==="'") {
      if (gd && source.slice(i,i+3)===c.repeat(3)) {
        string=c.repeat(3);output+='   ';i+=3;
      } else {string=c;escaped=false;output+=' ';i++;}
      continue;
    }
    output+=c;i++;
  }
  return output;
}
function lineAt(source, index) {
  let line=1;
  for(let i=0;i<index;i++) if(source.charCodeAt(i)===10) line++;
  return line;
}
function matching(masked, begin, open='(', close=')') {
  let depth=0;
  for(let i=begin;i<masked.length;i++) {
    const c=masked[i];
    if(c===open) depth++;
    else if(c===close) {depth--;if(depth===0)return i;}
  }
  return -1;
}
function splitArgs(raw, masked) {
  const result=[];
  let start=0, depths=[0,0,0];
  for (let i=0;i<masked.length;i++) {
    const c=masked[i];
    if(c==='(')depths[0]++;
    if(c===')')depths[0]--;
    if(c==='[')depths[1]++;
    if(c===']')depths[1]--;
    if(c==='{')depths[2]++;
    if(c==='}')depths[2]--;
    if(c===',' && depths.every(v=>v===0)) {
      result.push(raw.slice(start,i).trim());start=i+1;
    }
  }
  result.push(raw.slice(start).trim());
  return result.filter(Boolean);
}
function gdParameters(raw, masked) {
  return splitArgs(raw,masked).map(arg=>{
    const m=/^([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*(?:\[[\w.,\s]+\])?))?/.exec(arg);
    if(!m)return {name:'?',type:'Variant',explicit:false};
    return {name:m[1],type:m[2]||'Variant',explicit:!!m[2]};
  });
}
function cppParameters(raw, masked) {
  return splitArgs(raw,masked).filter(a=>a!=='void').map(arg=>{
    const part=arg.replace(/\s*=\s*[\s\S]*$/,'').trim();
    const m=/(?:^|[\s*&])([A-Za-z_]\w*)\s*(?:\[\s*\])?$/.exec(part);
    if(!m) return {name:'?',type:'unknown',explicit:false};
    const type=part.slice(0,m.index+m[0].indexOf(m[1])).trim();
    return {name:m[1],type:type||'unknown',explicit:!!type};
  });
}
function simpleCalls(masked) {
  const calls=[];
  const re=/(?<![\w:])([A-Za-z_]\w*)\s*\(/g;
  for(const match of masked.matchAll(re)) {
    if (!['if','else','while','for','switch','return','func','sizeof','catch'].includes(match[1])) calls.push(match[1]);
  }
  return [...new Set(calls)].sort();
}
function makeSymbol(file,lang,name,kind,start,end,params,returnType,bodyCalls,confidence,signature) {
  return {
    id:ID(lang+':'+file+':'+name+':'+start),
    file,name,kind,language:lang,confidence,
    lineStart:start,lineEnd:end,signature,
    inputs:params,outputs:returnType==='void'?[]:[{name:'return',type:returnType,explicit:returnType!=='Variant' && returnType!=='unknown'}],
    calls:bodyCalls
  };
}
function indexGDScript(source,file) {
  const masked=mask(source,'gdscript');
  const decl=/^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/gm;
  const declarations=[];
  for (const match of masked.matchAll(decl)) {
    const open=match.index+match[0].lastIndexOf('(');
    const close=matching(masked,open);
    if(close<0)continue;
    const suffix=masked.slice(close+1,Math.min(masked.length,close+160));
    const colon=/^\s*(?:->\s*([A-Za-z_]\w*(?:\[[\w.,\s]+\])?))?\s*:/.exec(suffix);
    if(!colon)continue;
    const bodyStart=close+1+colon[0].length;
    declarations.push({match,open,close,bodyStart,returnType:colon[1]||'Variant'});
  }
  const results=[];
  const rootBoundary=/^(?:(?:static\s+)?func|class_name|class|extends|signal|enum|const|var|@[\w.]+)\b/gm;
  const starts=[...masked.matchAll(rootBoundary)].map(m=>m.index).sort((a,b)=>a-b);
  for(const decl of declarations) {
    const next=starts.find(n=>n>decl.match.index);
    const bodyEnd=next===undefined?masked.length:next;
    const args=gdParameters(source.slice(decl.open+1,decl.close),masked.slice(decl.open+1,decl.close));
    const name=decl.match[1];
    const rawSig=source.slice(decl.match.index,decl.bodyStart).trim();
    results.push(makeSymbol(file,'gdscript',name,'function',lineAt(source,decl.match.index),
      lineAt(source,Math.max(decl.bodyStart,bodyEnd-1)),args,decl.returnType,
      simpleCalls(masked.slice(decl.bodyStart,bodyEnd)), 'lexical',rawSig));
  }
  return results;
}
function indexCpp(source,file) {
  const masked=mask(source,'cpp');
  const result=[];
  // deliberately narrow: definitions with a return type and an actual {body},
  // not prototypes, macros, lambdas, typedefs or statements.
  const decl=/^[ \t]*(?!#|if\b|for\b|while\b|switch\b|catch\b|return\b|else\b)(?:[\w:<>~*&]+\s+)+((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*\(/gm;
  for(const match of masked.matchAll(decl)) {
    const name=match[1];
    if(!NAME.test(name.split('::').at(-1))) continue;
    const open=match.index+match[0].lastIndexOf('(');
    const close=matching(masked,open);
    if(close<0)continue;
    const suffix=/^\s*(?:(?:const|noexcept|override|final)\s*)*\{/.exec(masked.slice(close+1,close+100));
    if(!suffix)continue;
    const bodyOpen=close+1+suffix[0].lastIndexOf('{');
    const bodyClose=matching(masked,bodyOpen,'{','}');
    if(bodyClose<0)continue;
    const before=match[0].slice(0,match[0].indexOf(name)).trim();
    const returnType=before.replace(/^(?:static|inline|virtual|constexpr|consteval|explicit)\s+/g,'').trim()||'unknown';
    const params=cppParameters(source.slice(open+1,close),masked.slice(open+1,close));
    const calls=simpleCalls(masked.slice(bodyOpen+1,bodyClose));
    result.push(makeSymbol(file,'cpp',name,'function',lineAt(source,match.index),
      lineAt(source,bodyClose),params,returnType,calls,'heuristic',source.slice(match.index,bodyOpen).trim()));
  }
  return result;
}
function indexSourceSymbols(source,file) {
  const ext=path.posix.extname(file).toLowerCase();
  if(ext==='.gd')return {status:'indexed',language:'gdscript',symbols:indexGDScript(source,file)};
  if(['.cpp','.cc','.c','.h','.hpp','.hh','.hxx','.inl'].includes(ext))
    return {status:'heuristic',language:'cpp',symbols:indexCpp(source,file)};
  return {status:'unsupported',language:null,symbols:[]};
}
function buildSymbolGraph(perFile) {
  const symbols=perFile.flatMap(e=>e.symbols);
  const lookup=new Map();
  for(const item of symbols){
    const key=item.file+'\0'+item.name.split('::').at(-1);
    const list=lookup.get(key)||[]; list.push(item);lookup.set(key,list);
  }
  const edges=[];
  for(const item of symbols) {
    for(const call of item.calls) {
      const found=lookup.get(item.file+'\0'+call)||[];
      if(found.length===1)edges.push({from:item.id,to:found[0].id,kind:'possible-direct-call',confidence:'heuristic'});
    }
  }
  edges.sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to));
  return {format:'tinner.symbol-graph.v1',semantics:'static heuristic; not executable',symbols,edges};
}
function buildSymbolFlow(graph,file) {
  const own=graph.symbols.filter(s=>s.file===file);
  const ids=new Set(own.map(s=>s.id));
  const tab=ID('tinner-symbol-tab:'+file);
  const links=new Map(own.map(s=>[s.id,[]]));
  for(const edge of graph.edges)if(ids.has(edge.from)&&ids.has(edge.to))links.get(edge.from).push(ID('node:'+edge.to));
  return [
    {id:tab,type:'tab',label:'Symbols: '+file,disabled:false,
      info:'Static inferred call graph; edges are non-executable and may be incomplete.'},
    ...own.map((s,i)=>({
      id:ID('node:'+s.id),type:'tinner-symbol',z:tab,
      name:s.name,signature:s.signature,relativePath:file,language:s.language,
      lineStart:s.lineStart,lineEnd:s.lineEnd,confidence:s.confidence,
      ports:JSON.stringify({inputs:s.inputs,outputs:s.outputs}),
      x:220+(i%4)*240,y:100+Math.floor(i/4)*85,
      wires:[links.get(s.id)]}))
  ];
}
module.exports={mask,indexSourceSymbols,buildSymbolGraph,buildSymbolFlow};
