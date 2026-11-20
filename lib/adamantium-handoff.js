'use strict';

// Safe, opt-in, non-executing Tinner graph handoff to Node-RED API v2.
// Only the project's own disabled reference tab may be replaced. No other
// user's flows are deleted. No automatic retry after a POST or uncertain result.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {liveStatus}=require('./live');
const {verifyProject}=require('./project');

const sha=body=>crypto.createHash('sha256').update(body).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
const FLOW_TYPES=new Set(['tab','tinner-project-module']);

function safeBase(value) {
  if(typeof value!=='string')throw Error('An explicit Adamantium-node URL is required');
  const parsed=new URL(value);
  const isLocal=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
  if(parsed.protocol!=='https:' && !(parsed.protocol==='http:'&&isLocal))
    throw Error('Only HTTPS or loopback HTTP is allowed for Node-RED API');
  if(parsed.username||parsed.password||parsed.search||parsed.hash)
    throw Error('URL must not contain credentials, query parameters or fragments');
  const base=parsed.toString().replace(/\/+$/,'');
  return base;
}
function owned(node,scope) {
  return node && node.tinnerManaged===true && node.tinnerScope===scope;
}
function validateGraph(graph,scope) {
  if(!Array.isArray(graph)||graph.length<2||graph.length>100000)
    throw Error('Invalid project graph');
  const ids=new Set();
  const tabs=graph.filter(x=>x.type==='tab');
  if(tabs.length!==1)throw Error('Expected one project graph tab');
  const tab=tabs[0];
  if(typeof tab.id!=='string'||!tab.id||!scope)throw Error('Invalid project namespace or tab ID');
  for(const node of graph) {
    if(!node || !FLOW_TYPES.has(node.type) || typeof node.id!=='string'||!node.id||
       ids.has(node.id) || (node!==tab && node.z!==tab.id))
      throw Error('Invalid or non-inert project graph node');
    ids.add(node.id);
  }
  for(const node of graph) {
    for(const group of node.wires||[]) {
      if(!Array.isArray(group) || group.some(id=>!ids.has(id)))
        throw Error('Project graph has an external wire target');
    }
  }
  return tab.id;
}
function loadAcceptedGraph(stateDir) {
  // A live revision is not accepted merely because it appears on disk.
  const before=liveStatus(stateDir,{verify:true});
  if(before.status!=='ready'||!before.revision)throw Error('No accepted Tinner revision');
  const bundle=path.join(path.resolve(stateDir),'revisions',before.revision);
  const {manifest}=verifyProject(bundle);
  if(!manifest.generatedArtifacts?.some(entry=>entry.path==='project-flow.json'))
    throw Error('No checksum-protected project graph in accepted revision');
  const data=fs.readFileSync(path.join(bundle,'project-flow.json'));
  const graph=JSON.parse(data.toString('utf8'));
  const scope=manifest.projectNamespace;
  const tabId=validateGraph(graph,scope);
  const after=liveStatus(stateDir);
  if(after.revision!==before.revision || after.paused!==before.paused)
    throw Error('Live project pointer changed while reading candidate');
  // These property fields are regular Node-RED node metadata and must survive
  // the API round-trip for future managed updates.
  const flows=graph.map(item=>({...clone(item),tinnerManaged:true,tinnerScope:scope,
    tinnerRevision:before.revision,...(item.type==='tab'?{disabled:true}:{})}));
  return {scope,revision:before.revision,tabId,flows,projectFiles:manifest.files.length,
    graphSha256:sha(data)};
}
function mergeGraph(remote,accepted) {
  if(!remote || typeof remote.rev!=='string'||!remote.rev||
     !Array.isArray(remote.flows))throw Error('Expected Node-RED API v2 revision and flows');
  const old=remote.flows,byId=new Map();
  for(const item of old) {
    if(!item || typeof item.id!=='string'||byId.has(item.id))
      throw Error('Invalid or duplicate remote Node-RED node IDs');
    byId.set(item.id,item);
  }
  const existing=byId.get(accepted.tabId);
  if(existing && (!owned(existing,accepted.scope)||existing.type!=='tab'))
    throw Error('Project tab ID collides with an unmanaged flow');
  const oldOwned=new Set();
  if(existing) {
    oldOwned.add(existing.id);
    for(const item of old)if(item.z===accepted.tabId) {
      if(!owned(item,accepted.scope)||item.type!=='tinner-project-module')
        throw Error('Managed tab contains an unrecognized or foreign node');
      oldOwned.add(item.id);
    }
  }
  const candidates=new Set(accepted.flows.map(n=>n.id));
  for(const item of old) {
    if(candidates.has(item.id)&&!oldOwned.has(item.id))
      throw Error('Import graph node ID collides with an existing foreign node');
  }
  const untouched=old.filter(node=>!oldOwned.has(node.id));
  // External links into the managed area are disallowed so deleting a
  // Tinner node cannot damage another user's runtime.
  for(const item of untouched) {
    if((item.wires||[]).some(group=>
      Array.isArray(group)&&group.some(id=>oldOwned.has(id)||candidates.has(id))))
      throw Error('Foreign node has a wire into the managed Tinner graph');
  }
  const merged=[...clone(untouched),...clone(accepted.flows)];
  return {rev:remote.rev,flows:merged,created:oldOwned.size===0,
    replaced:oldOwned.size,added:accepted.flows.length,
    preserved:untouched.length};
}
function parseRemoteSnapshot(payload) {
  const data=typeof payload==='string'?JSON.parse(payload):payload;
  if(!data || typeof data.rev!=='string'||!Array.isArray(data.flows))
    throw Error('Node-RED did not return a v2 flow snapshot');
  return data;
}
async function remoteRequest(base,method,token,body,fetcher=fetch) {
  const headers={'Node-RED-API-Version':'v2','Accept':'application/json'};
  if(token)headers.Authorization='Bearer '+token;
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method==='POST')headers['Node-RED-Deployment-Type']='nodes';
  const response=await fetcher(base+'/flows',{
    method,headers,body:body===undefined?undefined:JSON.stringify(body),
    redirect:'error',signal:AbortSignal.timeout(method==='POST'?45000:15000)
  });
  const text=await response.text();
  if(response.status===409)throw Error('Node-RED version mismatch (409); do not retry this deployment automatically');
  if(!response.ok)throw Error('Node-RED API '+method+' returned HTTP '+response.status);
  return text?parseRemoteSnapshot(text):null;
}
function writeBackup(directory,data) {
  const target=path.resolve(directory);
  if(!fs.existsSync(target))fs.mkdirSync(target,{recursive:true,mode:0o700});
  if(!fs.lstatSync(target).isDirectory()||fs.lstatSync(target).isSymbolicLink())
    throw Error('Backup directory must be a real directory');
  const file=path.join(target,'tinner-node-red-backup-'+crypto.randomBytes(12).toString('hex')+'.json');
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(data,null,2)+'\n');fs.fsyncSync(fd);}
  finally {fs.closeSync(fd);}
  return file;
}
async function handoff(stateDir,url,opts={}) {
  const base=safeBase(url);
  const accepted=loadAcceptedGraph(stateDir);
  const current=await remoteRequest(base,'GET',opts.token,undefined,opts.fetcher);
  const plan=mergeGraph(current,accepted);
  const output={status:'preview',remoteRevision:current.rev,
    tinnerRevision:accepted.revision,scope:accepted.scope,tabId:accepted.tabId,
    graphSha256:accepted.graphSha256,created:plan.created,
    replaced:plan.replaced,added:plan.added,preserved:plan.preserved};
  if(!opts.apply)return output;
  if(typeof opts.expectRev!=='string'||opts.expectRev!==current.rev)
    throw Error('Explicit --expect-rev must equal the current remote revision');
  if(!opts.backupDir)throw Error('An explicit local --backup-dir is required');
  // Recheck current local revision before the point of no return.
  if(loadAcceptedGraph(stateDir).revision!==accepted.revision)
    throw Error('Local project revision changed before deployment');
  const backup=writeBackup(opts.backupDir,{
    format:'tinner.node-red-backup.v1',source:base,scope:accepted.scope,
    tinnerRevision:accepted.revision,remoteRevision:current.rev,
    remoteFlows:current.flows
  });
  // Concurrency is guarded by the server-side rev CAS; never replay a timed-out
  // or failed POST. v2 deployment can trigger runtime restarts, not a hot-swap.
  const deployed=await remoteRequest(base,'POST',opts.token,
    {rev:plan.rev,flows:plan.flows},opts.fetcher);
  if(!deployed || typeof deployed.rev!=='string')
    throw Error('Deployment response ambiguous; inspect server state before any retry. Backup: '+backup);
  return {...output,status:'applied',newRemoteRevision:deployed.rev,backup};
}

module.exports={safeBase,validateGraph,loadAcceptedGraph,mergeGraph,
  parseRemoteSnapshot,handoff,writeBackup};
