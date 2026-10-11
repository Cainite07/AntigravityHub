'use strict';
// Cache only an exact, reviewed official base supplied by the user's installation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const profile=require('./unified-profile.json');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base=path.resolve(__dirname,profile.baseArchive),source=process.argv[2];
if(fs.existsSync(base)) {
  if(digest(base)!==profile.baseSha256)throw Error('本地原版底包校验失败，请重新提供经核验的 2.22.0 底包。');
} else {
  if(!source||digest(source)!==profile.baseSha256)
    throw Error('需要未经修改的 Antigravity 2.22.0 底包。请按 README 提供本地原版 app.asar；不会覆盖未知版本。');
  fs.mkdirSync(path.dirname(base),{recursive:true});
  fs.copyFileSync(source,base);
  if(fs.existsSync(source+'.unpacked'))fs.cpSync(source+'.unpacked',base+'.unpacked',{recursive:true});
}
console.log('Verified local base is ready.');
