'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {installControl}=require('../client/maintenance/tools/hub-client-settings');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-quit-test-'));
const app=new EventEmitter(); let quits=0;
app.getPath=()=>process.execPath; app.quit=()=>quits++;
const control=installControl(app,{directory,pid:42,now:()=>100000});
const ready=JSON.parse(fs.readFileSync(path.join(directory,'ready-42.json')));
const request=path.join(directory,'request-42.json');
const valid={pid:42,nonce:ready.nonce,action:'quit',id:'12345678-1234-1234-1234-123456789012',issuedAt:100000};
function send(value){fs.writeFileSync(request,JSON.stringify(value));control.check();}
try {
  for(const invalid of [{nonce:'wrong'}, {pid:43}, {action:'kill'}, {issuedAt:80000}, {issuedAt:110000}, {id:'bad'}]) send({...valid,...invalid});
  assert.equal(quits,0);
  send(valid);assert.equal(quits,1);assert.equal(fs.existsSync(request),false);
  send(valid);assert.equal(quits,1);
  // Cancelled official quit retains a usable capability for a later retry.
  send({...valid,id:'22345678-1234-1234-1234-123456789012'});assert.equal(quits,2);
  app.emit('quit');assert.equal(fs.existsSync(path.join(directory,'ready-42.json')),false);
  console.log('PASS: normal quit, nonce/PID/action validation, expiration, replay, retry and cleanup.');
} finally {control.cleanup();fs.rmdirSync(directory);}
