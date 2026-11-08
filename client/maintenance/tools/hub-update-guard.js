'use strict';
// The verified host hands localization recovery to the external tools before an update.
function install({app}) {
  let started=false;
  app.on('before-quit',()=>{
    if(started)return;started=true;
    try {
      if(!require('./hub-client-settings').read().localization)return;
      const fs=require('node:fs'),path=require('node:path');
      const file=path.join(require('node:os').homedir(),'.antigravity_hub','client_maintenance','launcher.json');
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      const root=path.resolve(value.hubRoot),script=path.join(root,'client','maintenance','tools','ui-guard.cjs');
      const node=path.join(root,'client','runtime','node','node.exe');
      if(!fs.existsSync(node)||!fs.existsSync(script))return;
      require('node:child_process').spawn(node,[script,'--after-update'],{detached:true,windowsHide:true,stdio:'ignore'}).unref();
    }catch{}
  });
}
module.exports={install};
