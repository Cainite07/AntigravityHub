'use strict';
// Development-only: npm install @babel/parser@8.0.7 in a separate tools folder.
// Usage: node dev/review-renderer.cjs LOCAL_RENDERER PARSER_MODULE_PATH
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const parser=require(process.argv[3] || '@babel/parser');
const source=fs.readFileSync(process.argv[2],'utf8');
const hash=crypto.createHash('sha256').update(source).digest('hex');
if(hash!=='867d1990b61d87f4b9ff8c5ecb1551c8688135267f32e56e02563f2d3e78fd68')throw Error('Unreviewed 2.23.0 renderer');
const root=path.resolve(__dirname,'../client/release-2.22.0/source/hans');
const dict={...require(path.join(root,'ui_dictionary.json')),...require(path.join(root,'ui_overrides.json'))};
const excluded=new Set(['Google Docs','Google Sheets','Google Slides','Google Drive','Google Calendar','Firebase','Science','Chrome DevTools','Android CLI','Gemini API','Google Antigravity SDK']);
const props=new Set(['label','title','placeholder','aria-label','ariaLabel','tooltip','tooltipText','alt','displayName','shortDisplayName','shortDescription','longDescription','emptyNote']);
const ast=parser.parse(source,{sourceType:'script'}),patches=[];
function key(node){return node?.name || node?.value;}
function role(node,parents){
  const parent=parents.at(-1);
  if(parent?.type==='ObjectProperty' && parent.value===node){
    const name=key(parent.key);
    if(props.has(name))return 'property:'+name;
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
  if(node.type==='StringLiteral' && !excluded.has(node.value)){
    const r=role(node,parents),translation=dict[node.value];
    if(r && typeof translation==='string' && translation!==node.value)patches.push({start:node.start,end:node.end,from:source.slice(node.start,node.end),to:JSON.stringify(translation),text:node.value,translation,role:r});
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
const profile={schema:1,version:'2.23.0',rendererSha256:hash,patches};
fs.mkdirSync(path.resolve(__dirname,'../client/release-2.23.0/source'),{recursive:true});
fs.writeFileSync(path.resolve(__dirname,'../client/release-2.23.0/source/ui-source-manifest.json'),JSON.stringify(profile,null,2)+'\n');
fs.writeFileSync(path.join(root,'ui-source-2230.js'),"'use strict';\n// Reviewed client display strings only; model requests and external fields are unchanged.\nmodule.exports="+JSON.stringify({sha256:hash,patches:patches.map(({start,end,from,to})=>({start,end,from,to}))})+';\n');
console.log('Reviewed UI spans:',patches.length,'renderer:',hash);
