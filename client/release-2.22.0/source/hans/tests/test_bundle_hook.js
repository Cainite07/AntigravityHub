'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {install,getStatus,isRendererBundle}=require('../hans-bundle-hook');
(async()=>{
  let source=fs.readFileSync(process.argv[2]||path.join(__dirname,'../../../evidence/2.19.1-renderer.clean.js'),'utf8'),handler;
  install({net:{fetch:async()=>new Response(source,{status:200,headers:{'content-length':'1','etag':'stale','content-encoding':'gzip'}})},
    session:{defaultSession:{protocol:{handle:(_,callback)=>{handler=callback;}}}}});
  assert(!isRendererBundle({method:'GET',url:'https://example.com/main.js'}));
  assert(!isRendererBundle({method:'POST',url:'https://127.0.0.1/main.js'}));
  const response=await handler({method:'GET',url:'https://127.0.0.1:1234/main.js'});
  const patched=await response.text();assert(patched.includes('singleTilde:!1'));assert.equal(getStatus().structuralApplied,true);
  assert.equal(getStatus().textMarkers.length,5);assert.deepEqual(getStatus().skippedTextMarkers,[]);
  assert.equal(response.headers.get('etag'),null);assert.equal(response.headers.get('content-length'),null);
  source+='/* unreviewed revision */';
  const rejected=await handler({method:'GET',url:'https://127.0.0.1:1234/main.js'});
  assert.equal(await rejected.text(),source);assert.equal(getStatus().structuralApplied,false);
  assert.equal(getStatus().reason,'Unreviewed renderer SHA-256');
  console.log('PASS: Actual 2.19.1 bundle applies, stale headers removed, unknown bundle stays unchanged');
})().catch(e=>{console.error(e);process.exitCode=1;});
