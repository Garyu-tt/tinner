'use strict';

// Streamed content fingerprints. This intentionally performs disk I/O on each
// poll; it must not silently trust timestamps when deciding to reuse source.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {enumerate}=require('./project');

function stamp(stat) {
  return [stat.size,stat.mtimeNs,stat.ctimeNs,stat.ino,stat.dev]
    .map(value=>value.toString());
}
function sameStamp(a,b) {
  return a.length===b.length && a.every((value,index)=>value===b[index]);
}
function snapshotContent(root) {
  const {result}=enumerate(root);
  const snapshot=Object.create(null);
  const hashes=Object.create(null);
  const buffer=Buffer.allocUnsafe(1024*1024);
  for (const rel of result) {
    const full=path.join(root,...rel.split('/'));
    const before=fs.lstatSync(full,{bigint:true});
    if(!before.isFile() || before.isSymbolicLink())
      throw new Error('Unsupported source entry: '+rel);
    const fd=fs.openSync(full,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try {
      const first=fs.fstatSync(fd,{bigint:true});
      if(!first.isFile()||!sameStamp(stamp(before),stamp(first)))
        throw new Error('Source file changed before hashing: '+rel);
      const hash=createHash('sha256');
      let count=0n;
      for(;;) {
        const n=fs.readSync(fd,buffer,0,buffer.length,null);
        if(n===0)break;
        hash.update(buffer.subarray(0,n));
        count+=BigInt(n);
      }
      const after=fs.fstatSync(fd,{bigint:true});
      const pathAfter=fs.lstatSync(full,{bigint:true});
      if(count!==first.size ||
        !sameStamp(stamp(first),stamp(after)) ||
        !sameStamp(stamp(first),stamp(pathAfter)) ||
        !pathAfter.isFile() || pathAfter.isSymbolicLink()) {
        throw new Error('Source file changed while hashing: '+rel);
      }
      snapshot[rel]=stamp(after);
      hashes[rel]=hash.digest('hex');
    } finally {fs.closeSync(fd);}
  }
  return {snapshot,hashes};
}
module.exports={snapshotContent};
