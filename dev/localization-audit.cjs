'use strict';
const crypto=require('node:crypto');
const policy=require('./localization-policy.json');
const id=(text,role)=>crypto.createHash('sha256').update(role+'\0'+text).digest('hex').slice(0,20);
const english=text=>text.length<500 && /[a-z]{2}/i.test(text) &&
  !/^(?:https?:|icon:|data:|[./\\~\[]|[\w.-]+\.(?:png|jpg|js|json|cjs|exe|pdf)$)/i.test(text) &&
  !/^[a-z_$][\w$./-]*$/.test(text) && !/[{}]|@keyframes/.test(text);
function candidate(text,role,start,end){
  if(!english(text))return null;
  return {id:id(text,role),text,role,start,end};
}
function audit({version,rendererSha256,candidates,patches},dict,previous=null){
  const unique=new Map(), applied=new Set(patches.map(p=>p.start+':'+p.end));
  const issues=[];
  for(const p of patches){
    if(p.from==null || p.to==null || p.start>=p.end)issues.push({category:'invalid-marker',text:p.text,role:p.role});
  }
  for(const item of candidates){
    if(!english(item.text))continue;
    const key=item.id;
    const category=policy.preserved.includes(item.text)?'preserved':applied.has(item.start+':'+item.end)?'translated':item.role==='review:dynamic'?'review-needed':
      typeof dict[item.text]==='string' && dict[item.text]!==item.text?'known-unapplied':
      item.role.startsWith('property:display') || item.role.startsWith('property:short') || item.role.startsWith('property:long') || item.role==='review:dynamic'?'review-needed':'new-untranslated';
    const old=unique.get(key);
    if(old && old.category!==category){
      // One displayed occurrence can be translated while a second one is missed.
      unique.set(key+':'+category,{...item,category});
    } else if(!old)unique.set(key,{...item,category});
  }
  const items=[...unique.values()];
  if(previous){
    const ids=new Set(candidates.map(c=>c.id));
    for(const old of previous.items || [])if(old.category==='translated' && !ids.has(old.id))
      items.push({...old,category:'missing-previous-marker'});
  }
  const summary={};for(const item of [...items,...issues])summary[item.category]=(summary[item.category]||0)+1;
  return {schema:1,version,rendererSha256,summary,items:[...items,...issues]};
}
module.exports={id,candidate,audit};
