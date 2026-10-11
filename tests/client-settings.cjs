'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const tools=path.resolve(__dirname,'../client/maintenance/tools');
const config=require(path.join(tools,'hub-client-settings.js'));
assert.equal(config.normalize({}).width,1400);
assert.equal(config.normalize({}).height,900);
assert.equal(config.normalize({}).localization,false);
assert.equal(config.normalize({EnableClientLocalization:'true'}).localization,false);
assert.equal(config.normalize({EnableClientLocalization:true}).localization,true);
for(const bad of [null,[],{}, {EnableClientWindowSize:true,ClientWindowWidth:100,ClientWindowHeight:800},
  {EnableClientWindowSize:true,ClientWindowWidth:1200.5,ClientWindowHeight:800}])assert.equal(config.normalize(bad).customSize,false);
let settings=config.normalize({EnableClientWindowSize:true,ClientWindowWidth:1200,ClientWindowHeight:700});
const area={x:1920,y:0,width:1600,height:900},display={workArea:area,bounds:{x:1920,y:0,width:1600,height:950}};
const moduleMock={exports:{}};
vm.runInNewContext(fs.readFileSync(path.join(tools,'layout.js'),'utf8'),{
  module:moduleMock,process:{argv:[]},require:name=>name==='electron'?{screen:{getDisplayMatching:()=>display,getPrimaryDisplay:()=>display}}:{read:()=>settings},setImmediate,clearImmediate
});
const layout=moduleMock.exports;
let target=layout.targetBounds();assert.equal(target.width,1200);assert.equal(target.height,700);assert.equal(target.x,2120);
settings={...settings,width:7680,height:4320};target=layout.targetBounds();assert.equal(target.width,1600);assert.equal(target.height,900);assert.equal(target.y,0);
class Window extends EventEmitter {
  constructor(){super();this.bounds={x:2000,y:40,width:1100,height:650};this.writes=0;this.shown=false;}
  isDestroyed(){return false;}getNormalBounds(){return this.bounds;}getBounds(){return this.bounds;}
  setBounds(next){this.bounds=next;this.writes++;}isMinimized(){return false;}isMaximized(){return false;}isFullScreen(){return false;}
  show(){this.shown=true;}focus(){}isFocused(){return true;}
}
settings={...settings,customSize:false};const window=new Window();layout.attach(window);assert.equal(window.writes,0);
layout.reveal(window);assert.equal(window.writes,0);
settings={...settings,customSize:true,width:1280,height:720};layout.reveal(window);assert.equal(window.bounds.width,1280);assert.equal(window.bounds.height,720);
const once=window.writes;layout.reveal(window);assert.equal(window.writes,once);
settings={...settings,width:1440,height:810};layout.reveal(window);assert.equal(window.bounds.width,1440);
settings={...settings,customSize:false};layout.reveal(window);assert.equal(window.bounds.width,1440);

(async()=>{
  const asar=await import(require('node:url').pathToFileURL(path.join(tools,'node_modules/@electron/asar/lib/asar.js')).href);
  const profile=require(path.join(tools,'unified-profile.json'));
  const base=path.resolve(tools,profile.baseArchive);
  const changes=require(path.join(tools,'unified-build.cjs')).changesFromBase(asar,base);
  let translated=0;
  const preload=changes.get('dist/preload.js').toString();
  const gate=preload.indexOf("require('electron').ipcRenderer.invoke('hub-client:settings')");
  const hud=preload.indexOf('// AntigravityHub',gate);
  // Test just the gated wrapper, through its rejection handler.
  const end=preload.indexOf('}).catch(() => {});',gate)+'}).catch(() => {});'.length;
  const code=preload.slice(gate,end);
  vm.runInNewContext(code,{require:()=>({ipcRenderer:{invoke:async()=>({localization:false})}}),window:new Proxy({},{get(){translated++;throw Error('Disabled engine executed');}})});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(translated,0);
  assert(changes.get('dist/main.js').toString().includes('read().localization'));
  assert(changes.get('dist/menu.js').toString().includes('read().localization'));
  assert(changes.get('dist/tray.js').toString().includes('read().localization'));
  for(const [file,bytes] of changes)new vm.Script(bytes.toString(),{filename:file});
  const hansMain=changes.get('dist/hans-main.js').toString();
  assert(hansMain.includes("read().thinking || !isTrustedSender(event)"));
  assert(hansMain.includes("'hans:translate-ui', () => []"));
  assert(changes.get('dist/hans-bundle-hook.js').toString().includes('if (!require(\'./hub-client-settings\').read().localization) return response;'));
  console.log('PASS: localization opt-in/defaults, invalid size rejection, multi-display clamping, free-size mode, live size changes, idempotent reveal, disabled preload, native menus, separate thinking opt-in and offline UI, all generated module syntax.');
})().catch(error=>{console.error(error);process.exitCode=1;});
