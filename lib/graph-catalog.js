'use strict';

// Pure, opt-in built-in graph handlers. The catalog is code shipped with
// Tinner, not JavaScript supplied by untrusted IR/messages.
const TABLE=new Map();
const MAX_ABS=1000000;
function finiteParam(params,key,fallback) {
  const value=params?.[key]===undefined?fallback:params[key];
  if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>MAX_ABS)
    throw Error('Invalid numeric node parameter '+key);
  return value;
}
function register(id,inputs,outputs,run,summary) {
  const version=1,key=id+'@'+version;
  TABLE.set(key,Object.freeze({id,version,kind:'handler',
    inputs,outputs,run,summary}));
}
register('mechanicus.identity',[{name:'input',type:'any'}],
  [{name:'output',type:'any'}],value=>value,
  'Forward a value unchanged');
register('mechanicus.math.offset',[{name:'input',type:'number'}],
  [{name:'output',type:'number'}],(value,{params})=>
    value+finiteParam(params,'offset',0),
  'Add a bounded constant to a finite number');
register('mechanicus.math.scale',[{name:'input',type:'number'}],
  [{name:'output',type:'number'}],(value,{params})=>
    value*finiteParam(params,'factor',1),
  'Scale a finite number by a bounded factor');
register('mechanicus.text.prefix',[{name:'input',type:'string'}],
  [{name:'output',type:'string'}],(value,{params})=>{
    const prefix=params?.prefix===undefined?'':params.prefix;
    if(typeof prefix!=='string'||prefix.length>1024)
      throw Error('Invalid prefix node parameter');
    return prefix+value;
  },'Prefix a string with a bounded literal');
register('mechanicus.json.pick',[{name:'input',type:'json'}],
  [{name:'output',type:'json'}],(value,{params})=>{
    const key=params?.key;
    if(typeof key!=='string'||key.length<1||key.length>128||
       ['__proto__','constructor','prototype'].includes(key))
      throw Error('Invalid JSON property name');
    return value!==null&&typeof value==='object'&&
      Object.hasOwn(value,key)?value[key]:null;
  },'Read one own JSON property by literal key');

function catalog() {
  return [...TABLE.values()].map(({id,version,inputs,outputs,summary})=>({
    id,version,inputs,outputs,summary
  }));
}
function bindingsFor(ir) {
  if(!ir||!Array.isArray(ir.definitions))
    throw Error('Graph definitions are required for trusted binding');
  const handlers=new Map();
  for(const definition of ir.definitions) {
    if(definition.kind!=='handler')continue;
    const key=definition.id+'@'+definition.version;
    const builtIn=TABLE.get(key);
    if(!builtIn)throw Error('No approved built-in handler for '+key);
    if(JSON.stringify(definition.inputs)!==JSON.stringify(builtIn.inputs)||
       JSON.stringify(definition.outputs)!==JSON.stringify(builtIn.outputs))
      throw Error('Trusted handler port ABI mismatch: '+key);
    handlers.set(key,builtIn.run);
  }
  return handlers;
}
module.exports={catalog,bindingsFor};
