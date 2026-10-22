'use strict';
// Development-only: npm install @babel/parser@8.0.7 in a separate tools folder.
// Usage: node dev/review-renderer.cjs LOCAL_RENDERER PARSER_MODULE_PATH
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const parser=require(process.argv[3] || '@babel/parser');
const source=fs.readFileSync(process.argv[2],'utf8');
const hash=crypto.createHash('sha256').update(source).digest('hex');
const version=process.argv[4] || '2.23.0';
const auditOnly=process.argv.includes('--audit-only');
const option=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const hashes={'2.23.0':'867d1990b61d87f4b9ff8c5ecb1551c8688135267f32e56e02563f2d3e78fd68','2.23.1':'ad12ecf66061edab6a3835d1360e1bad50787bc7b2f2c9d86568281360864696','2.24.0':'7a0bf9576e8ffd8e9fb39716368b1c79c2ccd965da65e049fe846100f34edf88','2.25.0':'91c2d259d53a16b0cb9afe87e5d9f173ba613a46a076032a179ac5eca5101463'};
if(!auditOnly && hash!==hashes[version])throw Error('Unreviewed renderer for '+version);
const root=path.resolve(__dirname,'../client/release-2.22.0/source/hans');
const dict={...require(path.join(root,'ui_dictionary.json')),...require(path.join(root,'ui_overrides.json'))};
const excluded=new Set(['Google Docs','Google Sheets','Google Slides','Google Drive','Google Calendar','Firebase','Science','Chrome DevTools','Android CLI','Gemini API','Google Antigravity SDK']);
const props=new Set(['label','title','placeholder','aria-label','ariaLabel','tooltip','tooltipText','alt','displayName','shortDisplayName','shortDescription','longDescription','emptyNote']);
const auditTool=require('./localization-audit.cjs');
const ast=parser.parse(source,{sourceType:'script'}),patches=[],candidates=[];
const functionKinds=new WeakMap();
function displayFunction(parents){
  const fn=parents.findLast(p=>['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(p.type));
  if(!fn)return null;if(functionKinds.has(fn))return functionKinds.get(fn);
  const text=source.slice(fn.start,fn.end);let kind=null;
  if(text.length<2200 && text.includes('`Explored ${') && text.includes('"commands"'))kind='activity-summary';
  else if(text.length<1800 && text.includes('return"Running command"') && text.includes('`Editing ${'))kind='activity-summary';
  else if(text.length<1800 && /\?"file":"files"/.test(text) && text.includes('"artifact":"artifacts"'))kind='activity-objects';
  else if(text.length<1200 && text.includes('hour:"h",day:"d",week:"w"'))kind='relative-time-units';
  else if(text.length<350 && text.includes('"just now"') && text.includes(' ago`'))kind='relative-time-ago';
  else if(text.length<600 && text.includes('Math.floor(a/1E3)') && text.includes('Math.floor(a/24)'))kind='duration';
  else if(text.length<600 && text.includes('Math.round(a)}ms`') && text.includes('.toFixed(2)}s`'))kind='duration';
  functionKinds.set(fn,kind);return kind;
}
const activityWords={Analyzing:'正在分析',Analyzed:'已分析',Exploring:'正在浏览',Explored:'已浏览',Searching:'正在搜索',Searched:'已搜索',Reading:'正在读取',Read:'已读取',Editing:'正在编辑',Edited:'已编辑',Creating:'正在创建',Created:'已创建',Deleting:'正在删除',Deleted:'已删除',Running:'正在运行',Ran:'已运行',ran:'已运行',edited:'已编辑',Working:'正在处理',Thinking:'正在思考',Done:'已完成','Running command':'正在运行命令',command:'命令',commands:'命令',file:'文件',files:'文件',artifact:'产物',artifacts:'产物'};
const timeUnits={s:'秒',m:'分钟',h:'小时',d:'天',w:'周',mo:'个月',y:'年',ms:'毫秒'};
const elapsedAt=source.indexOf('=a=>{a=Math.max(1,Math.floor(a/1E3))');
const elapsedFormatter=elapsedAt<0?null:source.slice(Math.max(0,elapsedAt-100),elapsedAt).match(/([\w$]+)$/)?.[1];
function key(node){return node?.name || node?.value;}
function role(node,parents){
  const parent=parents.at(-1);
  // Only fixed status prefixes passed to React UI components; never tool output.
  if(activityWords[node.value]){
    let index=parents.length-1;
    while(index>=0 && ['ConditionalExpression','LogicalExpression','BinaryExpression'].includes(parents[index].type))index--;
    const property=parents[index],object=parents[index-1],call=parents[index-2];
    if(property?.type==='ObjectProperty' && key(property.key)==='prefix' && object?.type==='ObjectExpression' && call?.type==='CallExpression' && call.callee?.property?.name==='createElement')return 'native-activity-prefix';
  }
  const kind=displayFunction(parents);
  if(kind?.startsWith('activity-') && (activityWords[node.value] || node.value===', '))return kind;
  if(kind==='relative-time-units' && parent?.type==='ObjectProperty' && ['hour','day','week','month','year','minute'].includes(key(parent.key)))return kind;
  if(kind==='relative-time-ago' && node.value==='just now')return kind;

  if(parent?.type==='ObjectProperty' && parent.value===node){
    const name=key(parent.key);
    if(props.has(name))return 'property:'+name;
    // Native archive notifications contain Markdown icons; preserve the markup
    // and translate only these two exact client-owned message fields.
    if(['message','plainTextFallback'].includes(name) && [
      'View archived in the sidebar (![filter](icon://filter_list) menu).',
      'View archived in the sidebar (Display options menu).'
    ].includes(node.value))return 'native-archive-notification';
    if(name==='description' && node.value==='Set the volume of agent sounds.' && parents.at(-2)?.type==='ObjectExpression' && parents.at(-2).properties.some(p=>key(p.key)==='label' && p.value?.value==='Volume'))return 'native-sound-volume-description';
    if(name==='description' && parents.some(p=>p.type==='ObjectProperty' && ['request_review','default','turbo'].includes(key(p.key))))return 'permission-preset-description';
  }
  let child=node;
  for(let i=parents.length-1;i>=0;i--){
    const p=parents[i];
    if(p.type==='CallExpression'){
      if(p.callee?.type==='MemberExpression' && p.callee.property?.name==='createElement' && p.callee.object?.name==='A' && p.arguments.indexOf(child)>=2)return 'react-child';
      break;
    }
    if(!['ConditionalExpression','LogicalExpression','BinaryExpression'].includes(p.type))break;
    child=p;
  }
  return null;
}
function walk(node,parents=[]){
  if(!node || typeof node!=='object')return;
  if(node.type==='StringLiteral'){
    const r=role(node,parents), item=r && auditTool.candidate(node.value,r,node.start,node.end);
    if(item)candidates.push(item);
  }
  if(node.type==='StringLiteral' && !excluded.has(node.value)){
    const r=role(node,parents);
    const translation=r==='native-activity-prefix'||r?.startsWith('activity-') ? (node.value===', '?'、':activityWords[node.value]) : r==='relative-time-units'?timeUnits[node.value]:r==='relative-time-ago'?'刚刚':dict[node.value];
    if(r && typeof translation==='string' && translation!==node.value)patches.push({start:node.start,end:node.end,from:source.slice(node.start,node.end),to:JSON.stringify(translation),text:node.value,translation,role:r});
  }
  if(node.type==='TemplateElement'){
    const kind=displayFunction(parents),raw=source.slice(node.start,node.end);let translated=raw;
    const template=parents.at(-1);
    const r=kind || (parents.some(p=>p.type==='ObjectProperty' && props.has(key(p.key)))?'review:dynamic':null);
    const item=r && auditTool.candidate(raw,r,node.start,node.end);if(item)candidates.push(item);
    if(template?.type==='TemplateLiteral' && template.expressions.length===1 && template.expressions[0]?.callee?.name===elapsedFormatter){
      if(raw==='Worked for ')translated='工作了 ';
      else if(raw==='Stopped after ')translated='运行 ';
    }

    if(kind==='activity-summary')translated=raw===' '?'':raw.replace(/^Explored /,'已浏览').replace(/^Editing /,'正在编辑');
    if(kind==='relative-time-ago' && raw===' ago')translated='前';
    if(kind==='duration')translated=raw.replace(/ms/g,'毫秒').replace(/[smhd]/g,c=>timeUnits[c]);
    if(translated!==raw)patches.push({start:node.start,end:node.end,from:raw,to:translated,text:raw,translation:translated,role:kind});
  }
  for(const [k,v] of Object.entries(node)){
    if(['loc','extra','leadingComments','trailingComments','innerComments','comments','tokens','errors'].includes(k))continue;
    if(Array.isArray(v)){for(const n of v)if(n?.type)walk(n,[...parents,node]);}
    else if(v?.type)walk(v,[...parents,node]);
  }
}
walk(ast);
patches.sort((a,b)=>a.start-b.start);
for(let i=1;i<patches.length;i++)if(patches[i-1].end>patches[i].start)throw Error('Overlapping UI spans');
const profile={schema:1,version,rendererSha256:hash,patches};
const inventory={schema:1,version,rendererSha256:hash,candidates,patches};
const previous=option('--previous');
const report=auditTool.audit(inventory,dict,previous?JSON.parse(fs.readFileSync(previous,'utf8')):null);
const output=option('--output');
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(auditOnly){console.log(JSON.stringify(report.summary));if(!output)console.log(JSON.stringify(report,null,2));process.exit(0);}
fs.mkdirSync(path.resolve(__dirname,'../client/release-'+version+'/source'),{recursive:true});
fs.writeFileSync(path.resolve(__dirname,'../client/release-'+version+'/source/ui-audit-inventory.json'),JSON.stringify({schema:1,version,rendererSha256:hash,candidates},null,2)+'\n');
fs.writeFileSync(path.resolve(__dirname,'../client/release-'+version+'/source/ui-source-manifest.json'),JSON.stringify(profile,null,2)+'\n');
fs.writeFileSync(path.join(root,'ui-source-'+version.replaceAll('.','')+'.js'),"'use strict';\n// Reviewed client display strings only; model requests and external fields are unchanged.\nmodule.exports="+JSON.stringify({sha256:hash,patches:patches.map(({start,end,from,to})=>({start,end,from,to}))})+';\n');
console.log('Reviewed UI spans:',patches.length,'renderer:',hash);
