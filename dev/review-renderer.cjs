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
const hashes={'2.28.2':'c3c5c9bb6d418e8d919cb94aa7de4df9ba449056b7d6122c32279ce72e2d2bad','2.23.0':'867d1990b61d87f4b9ff8c5ecb1551c8688135267f32e56e02563f2d3e78fd68','2.23.1':'ad12ecf66061edab6a3835d1360e1bad50787bc7b2f2c9d86568281360864696','2.24.0':'7a0bf9576e8ffd8e9fb39716368b1c79c2ccd965da65e049fe846100f34edf88','2.25.0':'91c2d259d53a16b0cb9afe87e5d9f173ba613a46a076032a179ac5eca5101463','2.26.0':'94abc09ac34dcae3a98f5e0fb74b66c87f8a8ad6ad214136544f924da2099e5e'};
hashes['2.29.0']='8d1196a22cd3eb9779e8faf5c31eb732d3df8d9d037b685733ed4e3d6cdfb5a2';
if(!auditOnly && hash!==hashes[version])throw Error('Unreviewed renderer for '+version);
const root=path.resolve(__dirname,'../client/release-2.22.0/source/hans');
const dict={...require(path.join(root,'ui_dictionary.json')),...require(path.join(root,'ui_overrides.json'))};
const is229=version==='2.29.0';
const versionWords=is229?require(path.join(root,'ui-overrides-2290.json')):{};
Object.assign(dict,versionWords);
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
const extraFields=new Set(['description','subtitle','hint','helpText','message','sidebarLabel','searchPlaceholder','historicalTooltip']);
const propertyOf=(node,name)=>node?.properties?.find(p=>key(p.key)===name)?.value;
function displaySite(node,parents){
  let child=node;
  for(let i=parents.length-1;i>=0;i--){
    const p=parents[i];
    if(p.type==='ObjectProperty'&&p.value===child){
      const name=key(p.key);
      if(['message','plainTextFallback'].includes(name)){
        const object=parents[i-1],call=parents[i-2];
        if(call?.callee?.property?.name==='createElement'||propertyOf(object,'isMarkdown')||propertyOf(object,'title'))return 'property:'+name;
        break;
      }
      if(props.has(name)||extraFields.has(name))return 'property:'+name;
      break;
    }
    if(p.type==='CallExpression'&&p.callee?.name==='un'&&p.arguments[0]===child)return 'native-toast';
    if(p.type==='CallExpression'&&p.callee?.property?.name==='createElement'&&p.callee.object?.name==='A'&&p.arguments.indexOf(child)>=2)return 'react-child';
    if(!['ConditionalExpression','LogicalExpression','BinaryExpression'].includes(p.type)||(p.type==='ConditionalExpression'&&p.test===child))break;
    child=p;
  }
  return null;
}
const context229=new Map([
  ['What can we get done today?','"home-greeting"'],
  ['This notebook has no renderable cells.','notebook:null,error:'],
  ['Invalid notebook JSON.','notebook:null,error:'],
  ['No recordings','Cxb(b,"call")'],
  ['Enter a side question after /btw','onValidationError'],
  ['Search shortcuts...','onQueryChange:b,placeholder:c='],
  ['Fork in Current Workspace','allowWorktree:'],
  ['A copy of the workspace snapshot recorded at this step.','historicalTooltip'],
  ['A full copy of this workspace, uncommitted changes included.','historicalTooltip'],
  ['Create a new workspace from your first message.','case "lastWorkspace"'],
  ['Start without a workspace, for general questions.','case "lastWorkspace"'],
  ['Reuse your last workspace.','case "lastWorkspace"'],
  ['Verbose','resolveOptionToString:g=>g?"Verbose":"Default"'],
]);
function role229(node,parents){
  const parent=parents.at(-1),object=parents.at(-2),field=key(parent?.key);
  if(node.value==='From' && field==='label' && parents.at(-3)?.arguments?.[0]?.name==='NB')return 'mail-sender';
  if(node.value==='End' && propertyOf(parent?.arguments?.[1],'className')?.value?.includes('/callbar:hidden'))return 'end-voice-call';
  if(node.value==='Instructions' && parent?.callee?.property?.name==='createElement' && source.slice(node.start-120,node.end+80).match(/automation-instructions-edit|ULc,\{prompt:/))return 'automation-instructions';
  if(parent?.type==='ObjectProperty'&&field==='title'&&propertyOf(object,'settings')?.type==='ArrayExpression')return 'internal-section-title';
  if(parent?.type==='ObjectProperty'&&field==='title'&&node.value==='Plan'&&parents.at(-3)?.arguments?.[0]?.name==='YP')return 'billing-plan-heading';
  // The runtime reconstructs both variants from the native nodes and preserves the query.
  if(parent?.type==='CallExpression'&&parent.arguments[2]?.value==='No '&&parent.arguments[3]?.property?.name==='emptyMessagePlural')return 'sidecar-empty-node';
  if(parent?.type==='ObjectProperty'&&['emptyMessagePlural','emptyMessageSingular'].includes(field))return 'sidecar-empty-node';
  const site=displaySite(node,parents);
  if(site && (versionWords[node.value]!==undefined || site==='property:description'&&dict[node.value]!==undefined))return site;
  const anchor=context229.get(node.value);
  if(anchor&&source.slice(Math.max(0,node.start-1500),node.end+1500).includes(anchor))return 'native-display-literal';
  return null;
}
function role(node,parents){
  const parent=parents.at(-1);
  if(is229){
    let child=node;
    for(let i=parents.length-1;i>=0;i--){
      const p=parents[i];
      if(!['ConditionalExpression','BinaryExpression','LogicalExpression'].includes(p.type))break;
      if((p.type==='ConditionalExpression'&&p.test===child)||(p.type==='BinaryExpression'&&p.operator!=='+')||(p.type==='LogicalExpression'&&p.operator==='&&'&&p.left===child))return null;
      child=p;
    }
    const site=role229(node,parents);
    if(site==='internal-section-title'||site==='sidecar-empty-node')return null;
    if(site)return site;
  }
  if(parent?.type==='ArrayExpression' && parent.elements[0]?.value==='Provide Feedback' &&
      parent.elements[1]===node && node.value==='Give Feedback')return 'native-settings-feedback-label';
  if(parent?.type==='ConditionalExpression' && node.value?.startsWith('Search tabs, files, extensions,') &&
      parents.some(p=>p.type==='ObjectExpression' && p.properties.some(v=>key(v.key)==='data-testid' && v.value?.value==='new-tab-search-input')))
    return 'native-tab-search-placeholder';
  if(['Built-in Browser','External Browser','Side Panel','Side Panel Preview',
      'Configure link opening and side panel preview preferences.',
      'Configure link opening and built-in browser preferences.'].includes(node.value) && parent?.type==='ConditionalExpression') {
    if(parents.some(p=>p.type==='ObjectExpression' && p.properties.some(v=>key(v.key)==='id' && v.value?.value==='defaultLinkOpenTarget')))
      return 'native-browser-preferences';
    const fn=parents.findLast(p=>['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(p.type));
    const body=fn && source.slice(fn.start,fn.end);
    if(body?.includes('browserPaneEngine===\"iframe\"') && body.includes('["defaultLinkOpenTarget",'))return 'native-browser-choice';
  }
  if(['2.26.0','2.28.2','2.29.0'].includes(version) && parent?.type==='CallExpression' && parent.callee?.property?.name==='createElement' &&
      parent.arguments[0]?.value==='div' && parent.arguments[2]?.value==='No ' && parent.arguments[4]?.value===' found' &&
      ['No ',' found'].includes(node.value))return 'native-empty-result';
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
    if(name==='description' && node.value==='Choose where links open by default when clicked.' &&
        parents.at(-2)?.properties.some(p=>key(p.key)==='label' && p.value?.value==='Open Links In'))return 'native-browser-description';
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
const scopedLabels={'billing-plan-heading':'套餐','mail-sender':'发件人','end-voice-call':'结束','automation-instructions':'任务指令'};
// These fragments are native React children around dynamic values. Never export them into the global dictionary.
const reactFragments={
  'Open ':'打开',' panel':'面板',' selected':' 项已选中','and ':'另有 ','Select all in ':'全部选中：','Select ':'选择',
  'Powered by Gemini Live · ':'由 Gemini Live 提供支持 · ','Use ':'使用',
  ' If you add multiple accounts, MCP servers use the one marked Default.':' 添加多个账号时，MCP 服务器会使用标记为默认的账号。',
  'Domains: ':'域名：','Used for: ':'用途：',' resources':'资源','Connect your account to browse ':'连接账号以浏览',
  'Delete ':'删除','Working directory: ':'工作目录：',' subagents':' 个子智能体',' Press':' 按',
  'Loading ':'正在加载','Could not load ':'无法加载','Couldn\'t switch accounts: ':'切换账号失败：','Signed in as ':'当前登录账号：',
  ' and make it the default.':'并将其设为默认账号。','To switch accounts, sign out in the ':'要切换账号，请先退出',
  ' and sign in again.':'，然后重新登录。','For corp passwords (such as ':'如需输入企业密码（例如 ',
  '), use an external SSH session':'），请使用外部 SSH 会话','or ':'或','% left':'% 剩余',' tokens used':' 个 Token 已用',
  ' on for this conversation':' 个已在此对话中启用','Agent: ':'智能体：','Thinking ':'正在思考','Zipping ':'正在压缩',
  'Get Anything Done with ':'使用以下工具开展工作：','menu)':'菜单）','Subagent: ':'子智能体：',
  'Card ':'卡片 ','Side Question: ':'临时提问：','on the':'日期','Reads ':'读取',
  ', read-only':'，只读',', always on.':'，始终运行。','An ':'',' with the ID “':'的 ID“','” already exists.':'”已存在。',
  ' with this name already exists on this computer. Run it remotely, or go back and rename it.':'在此计算机上已存在同名项。请在远程运行，或返回修改名称。',
  'Validated with GitHub and stored in':'已通过 GitHub 验证，存储于'
};
const portableTemplates=new Map();
const scopedPortableTemplates=new Map();
function portableScope(node,parents){
  const site=displaySite(node,parents);
  const attribute=({'property:aria-label':'aria-label','property:ariaLabel':'aria-label','property:placeholder':'placeholder','property:title':'title'})[site];
  let testId;
  for(let i=parents.length-1;i>=0;i--){
    const p=parents[i];
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(p.type))break;
    if(p.type!=='CallExpression'||p.callee?.property?.name!=='createElement')continue;
    const id=propertyOf(p.arguments[1],'data-testid')?.value;
    if(typeof id==='string'&&/^[a-z][a-z0-9-]{2,90}$/.test(id)){
      if(!/conversation-body|message-content|markdown|artifact-content|user-content|plugin-card|project-header|project-selector-item|file-tree|terminal-output/.test(id))testId=id;
      break;
    }
  }
  if(!testId&&!attribute)return null;
  return {...(testId?{testId}:{}),...(attribute?{attribute}:{})};
}
const portableStarts=[
  'Recording shortcut for ','Reset {0} to default','Downloads, ','Failed to delete recordings: ',
  'Failed to save cloud permission settings: ','No connectors match ','Context window about ',
  'Context window {0}% full','Side question failed: ','Edit side question title: ',
  'Select model, current: ','Where the agent runs, current: ','Voice Speed, ','Voice speed, ',
  'Created automation "','This deletes {0} (','No plugins found for "','Search Google for "',
  'ABFS workspace {0} created and selected.','Step {0} of {1}','Hi {0}, what can we get done today?',
  'Amended commit on {0}.','Attachment error: ','Cancel Questionnaire and Stop the Agent (',
  'Committed to {0}.','Creating ABFS workspace ','Deleted workspace ','MCP error: ',
  'Moved conversation ','Published {0} to origin.','Pushed to {0}.','Remounted workspace ',
  'Select model with ','Unmounted workspace ','Upload error: ',
  '{0} could not find the requested page.','{0} is currently unable to handle this request.',
  '{0} needs you to sign in before it can be used.','{0} Sends after agent finishes working. Actions available:',
  '{0}. Switch microphone.'
];
function reviewedTemplates(){
  const result=new Map();
  for(const {from,to} of require(path.join(root,'bundle_patch.js')).UI_SOURCE_PATCHES){
    if(!from.startsWith('\x60')||!to.startsWith('\x60'))continue;
    try {
      const a=parser.parseExpression(from),b=parser.parseExpression(to);
      if(a.type!=='TemplateLiteral'||b.type!=='TemplateLiteral'||!a.expressions.length)continue;
      const expressions=(node,text)=>node.expressions.map(e=>text.slice(e.start,e.end));
      if(JSON.stringify(expressions(a,from))!==JSON.stringify(expressions(b,to)))continue;
      result.set(signature(a),b.quasis.map(q=>q.value.cooked));
    }catch{}
  }
  for(const [english,chinese] of Object.entries(require('./ui-templates-2290.json'))){
    const slots=s=>[...s.matchAll(/\{(\d+)\}/g)].map(m=>Number(m[1]));
    const order=slots(english);
    if(!order.length||order.some((n,i)=>n!==i)||JSON.stringify(order)!==JSON.stringify(slots(chinese)))throw Error('Template arguments changed: '+english);
    result.set(english,chinese.split(/\{\d+\}/));
  }
  return result;
}
function signature(node){
  return node.quasis.map((q,i)=>q.value.cooked+(i<node.expressions.length?'{'+i+'}':'')).join('');
}
const templates=is229?reviewedTemplates():null;
function patchTemplate(node,parents){
  if(!node.expressions.length)return false;
  const english=signature(node),translated=templates.get(english);
  const greeting=english==='Hi {0}, what can we get done today?'&&source.slice(node.end,node.end+220).includes('"home-greeting"');
  const notebook=english==='Invalid notebook JSON: {0}'&&source.slice(node.start-40,node.start).includes('notebook:null,error:');
  if(!translated || !(displaySite(node,parents)||greeting||notebook))return false;
  const parts=node.quasis.map(q=>q.value.cooked);
  // Keep every interpolation, including comments and whitespace, byte-for-byte.
  const escape=s=>s.replaceAll('\\','\\\\').replaceAll('\x60','\\\x60').replaceAll('$'+'{','\\$'+'{');
  let replacement='\x60';
  for(let i=0;i<parts.length;i++){
    replacement+=escape(translated[i]);
    if(i+1<parts.length)replacement+=source.slice(node.quasis[i].end,node.quasis[i+1].start);
  }
  replacement+='\x60';
  const original=source.slice(node.start,node.end);
  if(replacement===original)return false;
  if(parts.slice(1,-1).every(Boolean) && parts.join('').trim().length>=5){
    if(portableStarts.some(prefix=>english.startsWith(prefix)))portableTemplates.set(english,{parts,translated});
    else{
      const scope=portableScope(node,parents);
      if(scope)scopedPortableTemplates.set(JSON.stringify([english,scope]),{parts,translated,scope});
    }
  }
  patches.push({start:node.start,end:node.end,from:original,to:replacement,text:english,translation:translated.map((s,i)=>s+(i<node.expressions.length?'{'+i+'}':'')).join(''),role:'native-display-template'});
  candidates.push({id:auditTool.id(english,'native-display-template'),text:english,role:'native-display-template',start:node.start,end:node.end});
  return true;
}
function walk(node,parents=[]){
  if(!node || typeof node!=='object')return;
  if(is229 && node.type==='CallExpression' && node.callee?.property?.name==='createElement' &&
      ['code','kbd','samp'].includes(node.arguments[0]?.value)){
    // Command samples and keycaps must retain exactly what the user can type.
    // A tooltip or accessible label on the element can still be localized.
    if(node.arguments[1])walk(node.arguments[1],[...parents,node]);
    return;
  }
  if(is229 && node.type==='TemplateLiteral' && patchTemplate(node,parents))return;
  if(node.type==='StringLiteral'){
    const r=role(node,parents), item=r && auditTool.candidate(node.value,r,node.start,node.end);
    if(item)candidates.push(item);
  }
  if(node.type==='StringLiteral' && !excluded.has(node.value)){
    const r=role(node,parents);
    const translation=r==='native-empty-result'?({'No ':'未找到',' found':''}[node.value]):r==='native-activity-prefix'||r?.startsWith('activity-') ? (node.value===', '?'、':activityWords[node.value]) : r==='relative-time-units'?timeUnits[node.value]:r==='relative-time-ago'?'刚刚':dict[node.value];
    const fragment=is229&&r==='react-child'?reactFragments[node.value]:undefined;
    const reviewed=fragment??scopedLabels[r]??translation;
    if(r && typeof reviewed==='string' && reviewed!==node.value)patches.push({start:node.start,end:node.end,from:source.slice(node.start,node.end),to:JSON.stringify(reviewed),text:node.value,translation:reviewed,role:fragment===undefined?r:'react-fragment'});
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
if(is229){
  // section.title is also the filtering key; localize only the value passed to the heading.
  const anchor='A.createElement(YP,{key:p,title:n.title,collapsible:n.collapsible';
  const start=source.indexOf(anchor);
  if(start<0||source.indexOf(anchor,start+1)>=0)throw Error('Settings section heading changed');
  const index=start+anchor.indexOf('n.title'),from='n.title';
  const labels={};
  for(const match of source.matchAll(/\{title:"([^"]+)",settings:\[/g))if(dict[match[1]])labels[match[1]]=dict[match[1]];
  patches.push({start:index,end:index+from.length,from,to:'('+JSON.stringify(labels)+'[n.title]??n.title)',text:from,role:'settings-section-heading'});
}
patches.sort((a,b)=>a.start-b.start);
for(let i=1;i<patches.length;i++)if(patches[i-1].end>patches[i].start)throw Error('Overlapping UI spans');
const profile={schema:1,version,rendererSha256:hash,patches};
if(is229){
  profile.portableTemplates=[...portableTemplates.values()];
  profile.scopedPortableTemplates=[...scopedPortableTemplates.values()];
}
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
const sourceIndex=Object.fromEntries(fs.readdirSync(root).filter(file=>/^ui-source-\d+\.js$/.test(file)).sort().map(file=>[require(path.join(root,file)).sha256,file.slice(0,-3)]));
fs.writeFileSync(path.join(root,'ui-source-index.json'),JSON.stringify(sourceIndex,null,2)+'\n');
