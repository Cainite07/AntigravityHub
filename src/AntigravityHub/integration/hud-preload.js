// Runs in Electron's isolated, sandboxed preload. No API is exposed to the renderer.
(()=>{
  if(window!==window.top)return;
  const {ipcRenderer}=require('electron');
  let host,shadow,pill,pop,anchor,snapshot=null,speed=null,speedRoute=null,speedEpoch=0,speedFlight=null,polling=false,timer,scanTimer,open=false,busy=false,lastPill="",lastPopover="";
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const quota=v=>Number.isFinite(v)&&v>=0&&v<=100?v:null;
  const label=v=>quota(v)===null?'—':`${v}%`;
  const reset=v=>{const ms=Date.parse(v)-Date.now();if(!Number.isFinite(ms)||ms<=0)return '—';const m=Math.ceil(ms/60000);return m<60?`${m}m`:m<1440?`${Math.floor(m/60)}h${m%60?String(m%60).padStart(2,'0'):''}`:`${Math.floor(m/1440)}d${Math.floor(m%1440/60)}h`;};
  function avatar(a){const src=typeof a.avatarDataUrl==='string'&&a.avatarDataUrl.length<700000&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(a.avatarDataUrl)?a.avatarDataUrl:'';return src?`<img class="avatar" src="${src}" alt="">`:`<span class="avatar initial">${escape((a.name||a.email||'?').slice(0,1).toUpperCase())}</span>`;}
  const css=`
    :host{display:inline-flex;align-items:center;flex-shrink:0;margin-right:4px;font-family:var(--font-family,system-ui),sans-serif;font-size:11px;line-height:1.4;font-weight:500;color-scheme:dark;color:var(--fg);--fg:#D5D5D2;--title:#ECEAE4;--muted:#A0A39F;--jade:#9EB9A8;--native:#25282C;--panel:color-mix(in srgb,var(--native) 88%,#373A3C);--line:#FFFFFF0D;--hover:#FFFFFF07;--track:#FFFFFF12;--tier:#C9B58C;--shadow:#0005}
    *{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer;border:0}button:focus-visible{outline:1px solid var(--jade);outline-offset:2px}
    .pill{display:flex;align-items:center;gap:7px;height:27px;padding:3px 8px 3px 4px;border-radius:20px;background:var(--hover);transition:background .15s;white-space:nowrap;font-variant-numeric:tabular-nums;box-shadow:none}
    .pill:hover,.pill[aria-expanded=true]{background:var(--track)}.avatar{width:19px;height:19px;object-fit:cover;border-radius:50%;flex:none}.initial{display:grid;place-items:center;background:var(--hover);font-size:11px;color:var(--jade)}
    .ring,.speed{display:flex;align-items:center;gap:5px}.ring{color:var(--jade)}.ring svg{width:16px;height:16px;transform:rotate(-90deg);flex:none}.speed svg{width:14px;height:14px;color:var(--muted)}.unit{font-size:10px;color:var(--muted);font-weight:400}.tokens{color:var(--muted)}.vline{height:12px;width:1px;background:var(--line);flex:none}
    .popover{zoom:.85;position:fixed;inset:auto;margin:0;padding:16px;width:340px;max-width:calc(100vw - 24px);border:1px solid var(--line);border-radius:15px;background:var(--panel);color:var(--fg);box-shadow:none;font:500 14px/1.45 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;overflow:auto;max-height:calc(100vh - 32px);font-variant-numeric:tabular-nums}
    .popover:focus{outline:none}.popover:popover-open{animation:enter .16s ease-out}.identity{display:flex;align-items:center;gap:10px}.identity .avatar{width:32px;height:32px}.name{font-size:14px;font-weight:600;color:var(--title);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.email{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.identity-text{min-width:0;flex:1}.tier{font-size:11px;font-weight:600;color:var(--tier)}
    .pools{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-top:16px;text-align:center}.pool{min-width:0}.pool-title{font-weight:600;color:var(--title)}.quota-circle{position:relative;width:78px;height:78px;display:grid;place-items:center;color:var(--jade);margin:10px auto 5px}.quota-circle svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}.quota-circle strong{font-size:21px;font-weight:600;color:var(--title)}.time{font-size:11px;color:var(--muted)}.quota-circle.low{color:var(--tier)}.week{display:flex;justify-content:space-between;font-size:11px;margin:15px 0 5px;color:var(--muted)}.week strong{font-weight:600;color:var(--title)}.meter{height:5px;background:var(--track);border-radius:4px;overflow:hidden;margin:7px 0}.meter span{display:block;height:100%;background:var(--jade);border-radius:inherit}
    .usage{display:flex;align-items:center;justify-content:space-between;padding-top:14px;margin-top:14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}.usage strong{font-size:16px;font-weight:600;color:var(--title)}.accounts{display:grid;gap:8px;margin-top:13px}.accounts:empty{display:none}.account{display:flex;align-items:center;gap:8px;text-align:left;padding:2px 0;background:transparent;width:100%}.account .account-text{min-width:0;flex:1}.account .name{font-size:12px;font-weight:500}.account small{display:block;font-size:10px;color:var(--muted)}.account .state{font-size:11px;color:var(--jade);white-space:nowrap}.account:hover,.hub:hover{opacity:.8}.account.busy{opacity:.6}.hub{display:flex;align-items:center;justify-content:space-between;width:100%;padding:0;background:transparent;color:var(--muted);font-size:12px;margin-top:15px}.error{font-size:11px;color:#BE997F;margin:6px 0 0}.error:empty{display:none}
    :host([data-light]){color-scheme:light;--fg:#4C4841;--title:#302E29;--muted:#7C786F;--jade:#577961;--native:#ECE5D6;--panel:color-mix(in srgb,var(--native) 82%,#DCD4C4);--line:#332D2410;--hover:#332D2405;--track:#332D2414;--tier:#91713C;--shadow:#2B251E24}
    .popover .name{font-size:16px}.popover .email,.popover .tier,.popover .time,.popover .week,.popover .account small,.popover .account .state,.popover .unit{font-size:12px}.popover .usage,.popover .hub{font-size:13px}.popover .account .name{font-size:14px}.popover .usage strong{font-size:18px}.popover .error{font-size:12px}
    .popover::-webkit-scrollbar{width:4px}.popover::-webkit-scrollbar-thumb{background:var(--track);border-radius:4px}
    @keyframes enter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}@media(max-width:850px){.pill{gap:6px;font-size:11px}}
  `;
  const media=matchMedia('(prefers-color-scheme: dark)');
  const colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=1;
  const colorContext=colorCanvas.getContext('2d',{willReadFrequently:true});
  const colorCache=new Map();
  function rgba(color){
    if(colorCache.has(color))return colorCache.get(color);
    // Native styles may be oklch()/color(), not just rgb(). Let Chromium resolve them.
    colorContext.clearRect(0,0,1,1);colorContext.fillStyle=color;colorContext.fillRect(0,0,1,1);
    const pixels=colorContext.getImageData(0,0,1,1).data;
    const result=[...pixels];if(colorCache.size>64)colorCache.clear();colorCache.set(color,result);return result;
  }
  const bright=rgb=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>155;
  function clientLight(){
    for(const node of [document.documentElement,document.body]){
      if(!node)continue;
      const declared=node.getAttribute('data-theme')||node.getAttribute('data-color-mode');
      if(declared==='light'||declared==='dark')return declared==='light';
      if(node.classList.contains('dark'))return false;
      if(node.classList.contains('light'))return true;
    }
    // Skip the microphone button and its wrappers: their surfaces are not the theme.
    let surface=anchor?.closest('.justify-between')?.parentElement||anchor?.parentElement?.parentElement;
    for(let i=0;surface&&i<12;i++,surface=surface.parentElement){
      const rgb=rgba(getComputedStyle(surface).backgroundColor);
      if(rgb[3]>230)return bright(rgb);
    }
    const scheme=getComputedStyle(document.documentElement).colorScheme;
    if(scheme==='light'||scheme==='dark')return scheme==='light';
    return !media.matches;
  }
  function syncTheme(){
    if(!host)return;const light=clientLight();host.toggleAttribute('data-light',light);
    let surface=anchor?.closest('.justify-between')?.parentElement||anchor?.parentElement?.parentElement;
    for(let i=0;surface&&i<12;i++,surface=surface.parentElement){
      const rgb=rgba(getComputedStyle(surface).backgroundColor);
      if(rgb[3]>230&&bright(rgb)===light){host.style.setProperty('--native',`rgb(${rgb.slice(0,3).join(',')})`);return;}
    }
    host.style.removeProperty('--native');
  }
  function close(){if(!open)return;open=false;try{pop.hidePopover();}catch{}pill.setAttribute('aria-expanded','false');}
  function position(){
    if(!open||!host.isConnected)return;
    const scale=.85,r=pill.getBoundingClientRect(),above=r.top-20,below=innerHeight-r.bottom-20,up=above>=below;
    pop.style.maxHeight=`${Math.max(80,up?above:below)/scale}px`;
    const bounds=pop.getBoundingClientRect();pop.style.left=`${Math.max(12,Math.min(r.right-bounds.width,innerWidth-bounds.width-12))/scale}px`;
    pop.style.top=`${(up?Math.max(12,r.top-bounds.height-8):r.bottom+8)/scale}px`;
  }
  function pool(title,v,w,t,tw){const q=quota(v),weekly=quota(w);return `<section class="pool"><div class="pool-title">${title}</div><div class="quota-circle${q!==null&&q<15?' low':''}" role="img" aria-label="${title} 五小时剩余 ${label(v)}"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="35" fill="none" stroke="var(--track)" stroke-width="4"/><circle cx="40" cy="40" r="35" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" pathLength="100" stroke-dasharray="${q??0} 100"/></svg><strong>${label(v)}</strong></div><div class="time">5h · ${reset(t)} 后刷新</div><div class="week"><span>每周</span><strong>${label(w)}</strong></div><div class="meter" role="img" aria-label="${title} 每周剩余 ${label(w)}"><span style="width:${weekly??0}%"></span></div><div class="time">${reset(tw)}</div></section>`;}
  const conversationId=()=>location.pathname.match(/^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i)?.[1]?.toLowerCase()||null;
  function syncConversation(){const id=conversationId();if(id!==speedRoute){speedRoute=id;speed=null;speedEpoch++;speedFlight=null;}return id;}
  async function pollSpeed(){const id=syncConversation(),epoch=speedEpoch;if(!id||speedFlight||!snapshot?.available||snapshot.enabled===false)return;const flight={};speedFlight=flight;try{const result=await ipcRenderer.invoke('hub-hud:speed',id);if(epoch===speedEpoch&&conversationId()===id)speed=result?.conversationId===id?result:null;}catch{if(epoch===speedEpoch)speed=null;}finally{if(speedFlight===flight)speedFlight=null;render();}}
  function render(){
    if(!host)return;const a=snapshot?.accounts?.find(a=>a.isCurrent);
    host.hidden=!snapshot?.available||snapshot.enabled===false||!a;if(host.hidden){host.style.display='none';close();return;}host.style.display='inline-flex';
    syncTheme();syncConversation();
    const toolbar=anchor?.closest('.justify-between');const claude=/claude|sonnet|opus|gpt-oss/i.test(toolbar?.textContent||'');const q=quota(claude?a.claude5hQuota:a.gemini5hQuota),t=claude?a.claudeResetTime5h:a.resetTime5h;
    const ringColor=q!==null&&q<15?'#B7946C':'var(--jade)';
    const pillHtml=avatar(a)+`<span class="ring" style="color:${ringColor}"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--track)" stroke-width="2"/><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" pathLength="100" stroke-dasharray="${q??0} 100"/></svg>${label(q)}</span><span class="vline" aria-hidden="true"></span><span class="speed" title="${escape(speed?.tps!=null?'会话输出速率 · 已完成请求的平均值'+(speed.basis==='all-output'?'（包含思考输出）':''):'当前会话暂无有效输出速率')}"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 12a6 6 0 1 1 11 0M8 9l3-4"/></svg><span>${Number.isFinite(speed?.tps)?speed.tps.toFixed(1):'—'}</span><span class="unit">tok/s</span></span><span class="vline" aria-hidden="true"></span><span class="tokens">${escape(snapshot.today||'0')}</span>`;
    if(pillHtml!==lastPill){pill.innerHTML=pillHtml;lastPill=pillHtml;}
    pill.title=`${a.email} · ${claude?'Claude':'Gemini'} 剩余 ${label(q)} · 今日 ${snapshot.today||'0'} Tokens`;
    if(open)renderPopover(a);
  }
  function renderPopover(a){
    const focused=shadow.activeElement?.dataset.account;const hubFocused=shadow.activeElement?.hasAttribute('data-open');const html=`<div class="identity">${avatar(a)}<div class="identity-text"><div class="name">${escape(a.name||a.email)}</div><div class="email">${escape(a.email)}</div></div>${a.tier?`<span class="tier">${escape(a.tier.replace('Google AI ',''))}</span>`:''}</div><div class="pools">${pool('Gemini',a.gemini5hQuota,a.geminiWeeklyQuota,a.resetTime5h,a.resetTimeWeekly)}${pool('Claude',a.claude5hQuota,a.claudeWeeklyQuota,a.claudeResetTime5h,a.claudeResetTimeWeekly)}</div><div class="usage"><span>今日用量</span><strong>${escape(snapshot.today||'0')} <span class="unit">tokens</span></strong></div><div class="accounts">${snapshot.accounts.filter(b=>!b.isCurrent).map(b=>`<button class="account${busy?' busy':''}" data-account="${escape(b.id)}" ${b.isCurrent||busy?'disabled':''}>${avatar(b)}<span class="account-text"><span class="name">${escape(b.name||b.email)}</span><small>${escape(b.email)}</small></span><span class="state">切换 →</span></button>`).join('')}</div><button class="hub" data-open>打开 AntigravityHub <span aria-hidden="true">↗</span></button><p class="error" aria-live="polite"></p>`;
    if(html===lastPopover){position();return;}lastPopover=html;pop.innerHTML=html;
    if(focused){const button=[...pop.querySelectorAll('[data-account]')].find(b=>b.dataset.account===focused);button?.focus();}else if(hubFocused)pop.querySelector('[data-open]')?.focus();position();
  }
  function mount(){
    if(host?.isConnected)return;
    const mic=document.querySelector('[data-tooltip-id="input-send-button-record-tooltip"]');if(!mic)return;
    let row=mic.parentElement;for(let i=0;i<4 && row && !(row.classList.contains('gap-1.5')&&row.classList.contains('flex'));i++)row=row.parentElement;
    if(!row||!row.classList.contains('gap-1.5'))return;
    close();lastPill='';lastPopover='';anchor=mic;host=document.createElement('span');host.id='antigravity-hub-hud';host.dataset.hansExternalContent='';host.style.display='none';shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML=`<style>${css}</style><button class="pill" aria-label="账号与用量" aria-haspopup="dialog" aria-expanded="false"></button><div class="popover" popover="manual" role="dialog" aria-label="账号与用量" tabindex="-1"></div>`;pill=shadow.querySelector('.pill');pop=shadow.querySelector('.popover');row.insertBefore(host,row.firstChild);
    for(let node=row.parentElement;node;node=node.parentElement)themeObserver.observe(node,{attributes:true,attributeFilter:['class','style','data-theme','data-color-mode']});
    pill.addEventListener('click',e=>{if(!e.isTrusted)return;if(open){close();return;}open=true;render();pop.showPopover();pill.setAttribute('aria-expanded','true');position();(e.detail===0?pop.querySelector('[data-account]:not(:disabled),[data-open]'):pop)?.focus({preventScroll:true});});
    pop.addEventListener('click',async e=>{if(!e.isTrusted||busy)return;const b=e.target.closest('button');if(!b)return;
      if(b.hasAttribute('data-open')){if(await ipcRenderer.invoke('hub-hud:open'))close();else pop.querySelector('.error').textContent='Hub 暂不可用';return;}
      if(b.dataset.account){busy=true;render();const ok=await ipcRenderer.invoke('hub-hud:switch',b.dataset.account).catch(()=>false);busy=false;if(!ok&&open)pop.querySelector('.error').textContent='切换未完成';await poll();}
    });render();
  }
  async function poll(){
    clearTimeout(timer);if(polling||document.hidden)return;
    polling=true;
    try{const previous=snapshot?.accounts?.find(a=>a.isCurrent)?.id;snapshot=await ipcRenderer.invoke('hub-hud:snapshot');if(previous!==snapshot?.accounts?.find(a=>a.isCurrent)?.id){speed=null;speedEpoch++;speedFlight=null;}mount();render();void pollSpeed();}
    catch{snapshot=null;render();}
    finally{polling=false;timer=setTimeout(poll,snapshot?.available?3000:800);}
  }
  function scheduleScan(){if(!scanTimer)scanTimer=setTimeout(()=>{scanTimer=null;mount();render();void pollSpeed();},100);}
  const themeObserver=new MutationObserver(scheduleScan);
  function start(){
    themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme','data-color-mode']});
    mount();const observer=new MutationObserver(records=>{if(conversationId()!==speedRoute||!host?.isConnected||records.some(r=>anchor?.closest('.justify-between')?.contains(r.target)))scheduleScan();});observer.observe(document.body,{childList:true,subtree:true});poll();
    media.addEventListener('change',syncTheme);
    document.addEventListener('visibilitychange',()=>{if(document.hidden){close();clearTimeout(timer);}else poll();});document.addEventListener('pointerdown',e=>{if(open&&!e.composedPath().includes(host))close();},true);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&open){close();pill.focus();e.stopPropagation();}else if(e.key==='Tab'&&open){const buttons=[...pop.querySelectorAll('button:not(:disabled)')];const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&(shadow.activeElement===first||shadow.activeElement===pop)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(shadow.activeElement===last||shadow.activeElement===pop)){e.preventDefault();first?.focus();}}},true);window.addEventListener('resize',position);document.addEventListener('scroll',position,true);
    window.addEventListener('pagehide',()=>{clearTimeout(timer);clearTimeout(scanTimer);observer.disconnect();themeObserver.disconnect();media.removeEventListener('change',syncTheme);close();},{once:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
