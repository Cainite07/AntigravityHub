'use strict';
// Rebuild both customizations from the exact audited clean 2.19.1 package.
// No installed files are written here. Only maintain.py commits a verified job.
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const os=require('node:os');
const {Readable}=require('node:stream');
const packing=require('./prepare.cjs');const adapter=require('./adapter2191.cjs');
const { Pickle }=require('./node_modules/@electron/asar/lib/pickle.js');
const hansRoot=path.resolve(__dirname,'../../release-2.22.0/source/hans');
const hudRoot=path.join(__dirname,'hud');
const MODULES=['translation-policy.js','bundle_patch.js','hans-bundle-hook.js','hans-main.js','hans-translator.js','ui-source-2230.js','ui-source-2231.js'];
function preserveExecutableFlags(asar,candidate,originalEntries){
  // asar 4.3 deliberately omits executable flags on Windows. Keep the three
  // audited upstream JS CLI flags in archive metadata without modifying payloads.
  const bytes=fs.readFileSync(candidate),oldHeaderSize=bytes.readUInt32LE(4);
  const header=asar.getRawHeader(candidate).header;
  for(const item of originalEntries){
    if(!item.e.executable)continue;
    let node=header;for(const segment of item.file.split('/'))node=node.files[segment];
    node.executable=true;
  }
  const headerPickle=Pickle.createEmpty();headerPickle.writeString(JSON.stringify(header));
  const encodedHeader=headerPickle.toBuffer();const sizePickle=Pickle.createEmpty();sizePickle.writeUInt32(encodedHeader.length);
  fs.writeFileSync(candidate,Buffer.concat([sizePickle.toBuffer(),encodedHeader,bytes.subarray(8+oldHeaderSize)]));
  asar.uncache(candidate);
}
function changesFromBase(asar,base){
  const get=file=>asar.extractFile(base,path.normalize('dist/'+file));
  const transformed=adapter.transform2191(get('utils.js'),get('tray.js'));
  const originalPreload=adapter.check('preload',get('preload.js'));
  const dictionary={...JSON.parse(fs.readFileSync(path.join(hansRoot,'ui_dictionary.json'))),...JSON.parse(fs.readFileSync(path.join(hansRoot,'ui_overrides.json')))};
  const engine=fs.readFileSync(path.join(hansRoot,'hans-preload.js'),'utf8');
  if(engine.split('__UI_DICT_JSON__').length!==2)throw Error('Invalid dictionary placeholder');
  const gatedEngine = `require('electron').ipcRenderer.invoke('hub-client:settings').then(settings => { if (settings?.localization === true || settings?.thinking === true) { const HUB_OPTIONS = settings;\n${engine.replace('__UI_DICT_JSON__',JSON.stringify(dictionary))}\n} }).catch(() => {});`;
  const preload=originalPreload+'\n\n// === Antigravity-Hans 22 / 2.19.1 ===\n'+gatedEngine+'\n\n'+fs.readFileSync(path.join(hudRoot,'hud-preload.js'),'utf8');
  const changes=new Map([
    ['dist/main.js',Buffer.from(adapter.patchMain(get('main.js'))+"\nrequire('./hub-hud-main').install(require('electron'));\nrequire('electron').app.whenReady().then(() => require('./hub-client-settings').installControl(require('electron').app)).catch(error => console.error('[Hub quit]', error));\n")],
    ['dist/menu.js',Buffer.from(adapter.patchMenu(get('menu.js')))],
    ['dist/preload.js',Buffer.from(preload)],
    ['dist/utils.js',Buffer.from(transformed.utils)],['dist/tray.js',Buffer.from(transformed.tray)],
    ['dist/codex-layout.js',fs.readFileSync(path.join(__dirname,'layout.js'))]
  ]);
  changes.set('dist/hub-client-settings.js',fs.readFileSync(path.join(__dirname,'hub-client-settings.js')));
  changes.set('dist/hub-hud-main.js',fs.readFileSync(path.join(hudRoot,'hub-hud-main.js')));
  for(const module of MODULES)changes.set('dist/'+module,fs.readFileSync(path.join(hansRoot,module)));
  for(const [filename,bytes] of changes)new vm.Script(bytes.toString(),{filename});
  return changes;
}
async function buildUnified(asar,archive,out){
  const before=await packing.inspect(asar,archive);
  const profile=require('./profiles.cjs').forVersion(before.version);
  if (!profile) throw Error('No reviewed profile for installed client version');
  const profileFile=path.join(__dirname,profile.file);
  if(before.version!==profile.version||!profile.allowedSourceHashes.includes(before.sha256)||before.integrityIssues.length)
    throw Error('Installed source is not a reviewed '+profile.version+' package; no installed files changed');
  const base=path.resolve(__dirname,profile.baseArchive);
  if(packing.sha(fs.readFileSync(base))!==profile.baseSha256)throw Error('Clean base changed');
  const original=await packing.inspect(asar,base);
  if(original.version!==profile.version||original.integrityIssues.length)throw Error('Invalid clean base');
  if(original.files.some(e=>e.path.includes('hans-')||e.path==='dist/codex-layout.js'))throw Error('Base is not clean/reviewed');
  const currentSidecar=before.files.filter(e=>e.unpacked);
  const cleanSidecar=original.files.filter(e=>e.unpacked);
  if(JSON.stringify(currentSidecar)!==JSON.stringify(cleanSidecar))throw Error('Installed/clean external resources differ');
  const changes=changesFromBase(asar,base);
  const actualTargets=Object.fromEntries([...changes].map(([file,bytes])=>[file,packing.sha(bytes)]));
  if(JSON.stringify(actualTargets)!==JSON.stringify(profile.targetModules))throw Error('Reviewed source files changed; regenerate and review the release profile');
  const items=packing.entries(asar.getRawHeader(base).header);
  const streams=items.map(item=>{
    const bytes=changes.get(item.file)||packing.payload(asar,base,item);
    return {path:item.file,type:'file',unpacked:item.unpacked,stat:{size:bytes.length,mode:item.e.executable?0o755:0o644},streamGenerator:()=>Readable.from(bytes)};
  });
  for(const [file,bytes] of changes)if(!items.some(e=>e.file===file))streams.push({path:file,type:'file',unpacked:false,stat:{size:bytes.length,mode:0o644},streamGenerator:()=>Readable.from(bytes)});
  fs.mkdirSync(out,{recursive:true});const candidate=path.resolve(out,'app.asar');
  // asar's small-file fast path can read a same-named file from the working
  // directory instead of our supplied stream (notably tools/package.json).
  // Build in an empty directory so every payload comes from the verified base.
  const previousDirectory=process.cwd(),emptyDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-asar-'));
  try {
    process.chdir(emptyDirectory);
    await asar.createPackageFromStreams(candidate,streams);
  } finally {
    process.chdir(previousDirectory);
    fs.rmdirSync(emptyDirectory);
  }
  preserveExecutableFlags(asar,candidate,items);
  const after=await packing.inspect(asar,candidate);
  const originalMap=new Map(original.files.map(e=>[e.path,e]));
  const addedCount=[...changes.keys()].filter(file=>!originalMap.has(file)).length;
  if(!after.unified||after.integrityIssues.length||after.files.length!==original.files.length+addedCount)throw Error('Combined candidate failed verification');
  for(const file of after.files){
    const old=originalMap.get(file.path);
    if(!old&&!changes.has(file.path))throw Error('Unexpected new file: '+file.path);
    if(old&&(old.unpacked!==file.unpacked||old.executable!==file.executable))throw Error('Archive attributes changed: '+file.path);
    if(file.sha256!==(changes.has(file.path)?packing.sha(changes.get(file.path)):old.sha256))throw Error('Unexpected payload change: '+file.path);
  }
  const now=await packing.inspect(asar,archive);
  if(now.sha256!==before.sha256||JSON.stringify(now.files)!==JSON.stringify(before.files))throw Error('Installed package changed during build');
  const record={schema:3,status:'prepared',version:profile.version,release:profile.release,unified:true,
    sourceArchive:path.resolve(archive),before:before.sha256,after:after.sha256,unpacked:currentSidecar,
    changes:[...changes.keys()],repairedMetadata:[],cleanBase:base,cleanBaseSha256:profile.baseSha256,
    rendererSha256:profile.rendererSha256,profileSha256:packing.sha(fs.readFileSync(profileFile)),preparedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(out,'prepared.json'),JSON.stringify(record,null,2));
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({baseFiles:original.files.length,candidateFiles:after.files.length,unpacked:currentSidecar.length,integrityIssues:after.integrityIssues,changes:[...changes.keys()],unrelatedPayloadsPreserved:true,targetModules:actualTargets},null,2));
  return record;
}
module.exports={changesFromBase,buildUnified};
