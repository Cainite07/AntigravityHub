'use strict';
// Retain approved UI translations across renderer releases; never read user data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),hans=path.join(root,'client/release-2.22.0/source/hans');
const destination=path.join(hans,'ui-translation-memory.json');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function mergeEntries(previous,dictionary,candidates,preserved=[]){
 const entries={...previous,...dictionary};
 for(const [from,values]of candidates)if(dictionary[from]===undefined && values.size===1)entries[from]=[...values][0];
 for(const term of preserved)delete entries[term];
 return entries;
}
function mergeTemplates(previous,current){
 const replacements=new Map(current.map(template=>[JSON.stringify(template.parts),template]));
 const retained=previous.map(template=>replacements.get(JSON.stringify(template.parts))||template);
 const known=new Set(previous.map(template=>JSON.stringify(template.parts)));
 for(const [key,template] of replacements)if(!known.has(key))retained.push(template);
 return retained;
}
function trimTemplate(template){
 const parts=[...template.parts],translated=[...template.translated];
 parts[0]=parts[0].trimStart();parts[parts.length-1]=parts.at(-1).trimEnd();
 translated[0]=translated[0].trimStart();translated[translated.length-1]=translated.at(-1).trimEnd();
 return {parts,translated};
}
function validateTemplate({parts,translated},minimumLength,version){
 if(!Array.isArray(parts)||!Array.isArray(translated)||parts.length<2||parts.length!==translated.length||
    !parts.every(part=>typeof part==='string')||!translated.every(part=>typeof part==='string')||
    parts.join('').trim().length<minimumLength||parts.slice(1,-1).some(part=>!part)){
  throw Error('Invalid portable template in '+version);
 }
}
function mergeScopedTemplates(previous,current,version){
 const byScope=new Map();
 for(const template of [...previous,...current]){
  validateTemplate(template,1,version);
  const {testId,attribute}=template.scope||{};
  if((!testId&&!attribute)||(testId!==undefined && (typeof testId!=='string'||!/^[A-Za-z0-9_-]+$/.test(testId)))||
     (attribute!==undefined && !['title','aria-label','placeholder'].includes(attribute))){
   throw Error('Invalid template scope in '+version);
  }
  const record={...trimTemplate(template),scope:{...(testId?{testId}:{}),...(attribute?{attribute}:{})}};
  byScope.set(JSON.stringify([testId||'',attribute||'',record.parts]),record);
 }
 return [...byScope.values()];
}
function collect(parserPath){
 const files=['ui_dictionary.json','ui_overrides.json','ui-overrides-2290.json'].map(file=>path.join(hans,file));
 const manifests=fs.readdirSync(path.join(root,'client')).filter(file=>file.startsWith('release-'))
  .map(file=>path.join(root,'client',file,'source/ui-source-manifest.json')).filter(file=>fs.existsSync(file));
 const readJson=file=>({file,value:JSON.parse(fs.readFileSync(file,'utf8'))});
 const dictionaries=files.map(readJson),manifestInputs=manifests.map(readJson);
 const dictionary=Object.assign({},...dictionaries.map(input=>input.value));
 const previous=fs.existsSync(destination)?JSON.parse(fs.readFileSync(destination,'utf8')):null;
 const reviewed=manifestInputs.map(input=>input.value);
 const candidates=new Map();
 for(const manifest of reviewed)for(const patch of manifest.patches||[]){
  if(!/^(property:|react-child|native-settings|native-browser|native-tab|native-archive)/.test(patch.role||''))continue;
  const from=patch.text,to=patch.translation;
  if(typeof from!=='string'||typeof to!=='string'||!from.trim()||from!==from.trim()||from===to)continue;
  if(!candidates.has(from))candidates.set(from,new Set());candidates.get(from).add(to);
 }
 const entries=mergeEntries(previous?.entries,dictionary,candidates);
 const legacy=require('../client/release-2.22.0/source/hans/bundle_patch').UI_SOURCE_PATCHES;
 const legacySha256=digest(JSON.stringify(legacy));
 let templates=previous?.legacySha256===legacySha256?previous.templates:null;
 if(!templates){
  const parser=require(parserPath||process.env.ANTIGRAVITY_BABEL_PARSER||'@babel/parser');templates=[];
  for(const patch of legacy){
   try {
    const from=parser.parseExpression(patch.from),to=parser.parseExpression(patch.to);
    if(from.type==='StringLiteral'&&to.type==='StringLiteral'&&dictionary[from.value]===undefined)entries[from.value]=to.value;
    if(from.type!=='TemplateLiteral'||to.type!=='TemplateLiteral'||!from.expressions.length||from.expressions.length>3)continue;
    const a=from.expressions.map(e=>patch.from.slice(e.start,e.end)),b=to.expressions.map(e=>patch.to.slice(e.start,e.end));
    if(JSON.stringify(a)!==JSON.stringify(b))continue;
    const parts=from.quasis.map(q=>q.value.cooked),translated=to.quasis.map(q=>q.value.cooked);
    if(parts.some(p=>p===null)||translated.some(p=>p===null)||parts.join('').trim().length<5||parts.slice(1,-1).some(p=>!p))continue;
    templates.push({parts,translated});
   }catch{}
  }
 }
 templates=templates.map(trimTemplate);
 if(previous && previous.legacySha256!==legacySha256)templates=mergeTemplates(previous.templates||[],templates);
 let scopedTemplates=previous?.scopedTemplates||[];
 for(const manifest of reviewed){
  const portable=manifest.portableTemplates || [];
  for(const template of portable)validateTemplate(template,5,manifest.version);
  templates=mergeTemplates(templates,portable.map(trimTemplate));
  if(manifest.scopedPortableTemplates)scopedTemplates=mergeScopedTemplates(scopedTemplates,manifest.scopedPortableTemplates,manifest.version);
 }
 // A reviewed contextual correction also retires earlier global translations saved across upgrades.
 const policy=require('./localization-policy.json');
 for(const term of [...policy.preserved,...policy.contextOnly])delete entries[term];
 // Hash the parsed JSON so checkout line endings and formatting do not affect the build.
 const sources=[...dictionaries,...manifestInputs].map(({file,value})=>({
  path:path.relative(root,file).replaceAll('\\','/'),sha256:digest(JSON.stringify(value))
 }));
 return {schema:1,legacySha256,sources,entries:Object.fromEntries(Object.entries(entries).sort(([a],[b])=>a.localeCompare(b,'en'))),templates,scopedTemplates};
}
function verify(){
 if(!fs.existsSync(destination))throw Error('Persistent UI memory missing; run dev/build-ui-memory.cjs');
 const existing=JSON.parse(fs.readFileSync(destination,'utf8')),expected=collect();
 if(JSON.stringify(existing)!==JSON.stringify(expected))throw Error('Persistent UI memory is stale; regenerate approved translations');
 return existing;
}
if(require.main===module){const index=process.argv.indexOf('--parser'),value=collect(index>=0?process.argv[index+1]:undefined);fs.writeFileSync(destination,JSON.stringify(value,null,2)+'\n');console.log('Persistent UI memory: '+Object.keys(value.entries).length+' fixed phrases, '+value.templates.length+' shared templates, '+value.scopedTemplates.length+' scoped templates.');}
module.exports={collect,verify,mergeEntries,mergeTemplates,mergeScopedTemplates};
