'use strict';
// Cache only an exact, reviewed official base supplied by the user's installation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
const asar=await import('@electron/asar');
const source=process.argv[2];
if(!source)throw Error('Missing installed archive');
const version=JSON.parse(asar.extractFile(source,'package.json')).version;
const profile=require('./profiles.cjs').forVersion(version);
if(!profile)throw Error('尚未审核的客户端版本：'+version);
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base=path.resolve(__dirname,profile.baseArchive);
if(fs.existsSync(base)) {
  if(digest(base)!==profile.baseSha256)throw Error('本地原版底包校验失败：'+version);
} else {
  if(!source||digest(source)!==profile.baseSha256)
    throw Error('需要未经修改的 Antigravity '+version+' 原版底包；不会覆盖未知文件。');
  fs.mkdirSync(path.dirname(base),{recursive:true});
  fs.copyFileSync(source,base);
  if(fs.existsSync(source+'.unpacked'))fs.cpSync(source+'.unpacked',base+'.unpacked',{recursive:true});
}
console.log('Verified local base is ready.');

})().catch(error=>{console.error(error.message);process.exitCode=1;});
