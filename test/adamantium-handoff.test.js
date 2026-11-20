'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {scanProject}=require('../lib/live');
const {
  safeBase,loadAcceptedGraph,mergeGraph,handoff
}=require('../lib/adamantium-handoff');

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tinner-handoff-'));
  const project=path.join(root,'source'),state=path.join(root,'state');
  fs.mkdirSync(path.join(project,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(project,'project.godot'),'[application]\nconfig/name="handoff"\n');
  fs.writeFileSync(path.join(project,'scripts','main.gd'),
    'extends Node\nfunc _ready() -> void:\n    print("hello")\n');
  const rev=scanProject(project,state);
  return {root,project,state,rev};
}
function cleanup(f){fs.rmSync(f.root,{recursive:true,force:true});}
function remote(rev='remote-v3') {
  return {rev,flows:[
    {id:'foreign-tab',type:'tab',label:'Production'},
    {id:'foreign-node',type:'inject',z:'foreign-tab',wires:[[]]}
  ]};
}
function response(payload,status=200) {
  return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});
}
function mockFetch(snapshot,onPost=()=>response({rev:'remote-v4'})) {
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(options.method==='GET')return response(snapshot);
    if(options.method==='POST')return onPost(url,options);
    throw Error('Unsupported HTTP verb');
  };
  return {fetcher,calls};
}

test('accepted project flow is inert, checksum-backed, and revision scoped',()=>{
  const f=fixture();
  try {
    const accepted=loadAcceptedGraph(f.state);
    assert.equal(accepted.revision,f.rev.revision);
    assert.equal(accepted.flows[0].disabled,true);
    assert.equal(accepted.flows[0].type,'tab');
    assert.ok(accepted.flows.every(n=>n.tinnerManaged===true));
    assert.ok(accepted.flows.every(n=>n.tinnerScope===accepted.scope));
    assert.ok(accepted.flows.every(n=>n.type==='tab'||n.type==='tinner-project-module'));
    assert.match(accepted.graphSha256,/^[a-f0-9]{64}$/);
  }finally{cleanup(f);}
});

test('preview reads official Node-RED v2 API and never POSTs',async()=>{
  const f=fixture();
  try{
    const mocked=mockFetch(remote());
    const preview=await handoff(f.state,'http://127.0.0.1:1880',{fetcher:mocked.fetcher});
    assert.equal(preview.status,'preview');
    assert.equal(preview.remoteRevision,'remote-v3');
    assert.equal(preview.preserved,2);
    assert.equal(preview.created,true);
    assert.equal(mocked.calls.length,1);
    assert.equal(mocked.calls[0].options.method,'GET');
    assert.equal(mocked.calls[0].options.headers['Node-RED-API-Version'],'v2');
  }finally{cleanup(f);}
});

test('apply requires expected revision and backup path; never writes without them',async()=>{
  const f=fixture();
  try{
    const mocked=mockFetch(remote());
    await assert.rejects(()=>handoff(f.state,'https://node.example.test',{
      apply:true,expectRev:'old-rev',backupDir:path.join(f.root,'backups'),fetcher:mocked.fetcher
    }),/expect-rev/);
    await assert.rejects(()=>handoff(f.state,'https://node.example.test',{
      apply:true,expectRev:'remote-v3',fetcher:mocked.fetcher
    }),/backup-dir/);
    assert.equal(mocked.calls.every(call=>call.options.method==='GET'),true);
  }finally{cleanup(f);}
});

test('approved apply sends scoped merge with rev CAS and stores private rollback snapshot',async()=>{
  const f=fixture();
  try{
    const mocked=mockFetch(remote());
    const backupDir=path.join(f.root,'backups');
    const done=await handoff(f.state,'https://node.example.test',{
      apply:true,expectRev:'remote-v3',backupDir,fetcher:mocked.fetcher,token:'redacted-token'
    });
    assert.equal(done.status,'applied');
    assert.equal(done.newRemoteRevision,'remote-v4');
    assert.equal(mocked.calls.length,2);
    const post=mocked.calls[1];
    assert.equal(post.options.method,'POST');
    assert.equal(post.options.headers['Node-RED-API-Version'],'v2');
    assert.equal(post.options.headers['Node-RED-Deployment-Type'],'nodes');
    assert.equal(post.options.headers.Authorization,'Bearer redacted-token');
    const request=JSON.parse(post.options.body);
    assert.equal(request.rev,'remote-v3');
    assert.ok(request.flows.some(node=>node.id==='foreign-node'));
    assert.ok(request.flows.some(node=>node.id===done.tabId&&node.disabled===true));
    const backup=JSON.parse(fs.readFileSync(done.backup,'utf8'));
    assert.deepEqual(backup.remoteFlows,remote().flows);
    if(process.platform!=='win32') assert.equal(fs.statSync(done.backup).mode&0o777,0o600);
  }finally{cleanup(f);}
});

test('updating a managed tab never deletes foreign flows',()=>{
  const f=fixture();
  try{
    const accepted=loadAcceptedGraph(f.state);
    const old=remote();
    old.flows.push(...accepted.flows);
    const newer=mergeGraph(old,accepted);
    assert.equal(newer.created,false);
    assert.equal(newer.replaced,accepted.flows.length);
    assert.equal(newer.preserved,2);
    assert.deepEqual(newer.flows.slice(0,2),remote().flows);
  }finally{cleanup(f);}
});

test('unmanaged tab collision and foreign nodes inside managed tab abort',()=>{
  const f=fixture();
  try{
    const accepted=loadAcceptedGraph(f.state);
    const old=remote();
    old.flows.push({id:accepted.tabId,type:'tab',label:'My tab'});
    assert.throws(()=>mergeGraph(old,accepted),/collides with an unmanaged/);
    old.flows[2]={...accepted.flows[0]};
    old.flows.push({id:'foreign-inner',type:'inject',z:accepted.tabId});
    assert.throws(()=>mergeGraph(old,accepted),/unrecognized or foreign/);
  }finally{cleanup(f);}
});

test('foreign nodes wired into a managed graph stop managed refresh',()=>{
  const f=fixture();
  try{
    const accepted=loadAcceptedGraph(f.state);
    const old=remote();
    old.flows.push(...accepted.flows);
    old.flows[1].wires=[[accepted.flows[1].id]];
    assert.throws(()=>mergeGraph(old,accepted),/Foreign node has a wire/);
  }finally{cleanup(f);}
});

test('server CAS 409 must not automatically retry; retain backup',async()=>{
  const f=fixture();
  try{
    const mocked=mockFetch(remote(),()=>response({code:'version_mismatch'},409));
    const backupDir=path.join(f.root,'backups');
    await assert.rejects(()=>handoff(f.state,'https://node.example.test',{
      apply:true,expectRev:'remote-v3',backupDir,fetcher:mocked.fetcher
    }),/409.*do not retry/i);
    assert.equal(mocked.calls.length,2);
    assert.equal(fs.readdirSync(backupDir).length,1);
  }finally{cleanup(f);}
});

test('refuse credential URLs, nonlocal HTTP, redirects and invalid v2 responses',async()=>{
  for(const u of ['http://node.example.test','http://evil.test:1880',
    'https://user:password@host.test','https://host.test?token=x'])
    assert.throws(()=>safeBase(u),/HTTPS|credentials/);
  const f=fixture();
  try{
    const mocked=mockFetch({flows:[]});
    await assert.rejects(()=>handoff(f.state,'https://node.example.test',{
      fetcher:mocked.fetcher
    }),/v2 flow snapshot/);
  }finally{cleanup(f);}
});
