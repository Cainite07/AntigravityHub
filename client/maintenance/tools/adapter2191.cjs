'use strict';
const crypto = require('node:crypto');
const sha = source => crypto.createHash('sha256').update(source).digest('hex');
const INPUTS = {
  utils: '6f01d746963c0cd964dbcb057ed34374c129c4381b5ebddd2509ca37b12519a7',
  tray: '6c6b0968b45a1c7088e459657d57a9efd72d3733614349095f17b6ee94b47135',
  main: 'adf9f814ce9a7df067d7c226354f5b5c160797ed6aefc3e45c343d2f91af52f8',
  preload: 'ed1c35b78075de3fe76e6a504e90c5ba6380a7b6491dc2e819f729911e4b38d2',
  menu: '0bb689f3f77f5f30d9345302ff94ebabbe461c4b94de9ffdb711a19eeca0f04f'
};
function one(source,from,to){if(source.split(from).length!==2)throw Error('Missing/ambiguous 2.19.1 anchor: '+from.slice(0,90));return source.replace(from,to);}
function check(name,bytes){if(!(name === 'preload' ? [INPUTS[name],'81d220de63447d27db95adf67d9711b59ee317b2338ba538f419b354a54b1f60'] : name === 'main' ? [INPUTS[name],'afadfbb9c0880f081dd763caa2b9525b2590631ab8fd58cd82e2d67075df1a42'] : [INPUTS[name]]).includes(sha(bytes)))throw Error('Unreviewed 2.19.1 module: '+name);return bytes.toString().replace(/\r\n/g,'\n');}
function transform2191(utilsBytes,trayBytes){
  let utils=check('utils',utilsBytes),tray=check('tray',trayBytes);
  utils=one(utils,'const electron_1 = require("electron");','const electron_1 = require("electron");\n// Codex unified Antigravity 2.19.1 window policy\nconst codexLayout = require("./codex-layout");');
  utils=one(utils,'    const win = new electron_1.BrowserWindow({\n        width: 1400,\n        height: 900,','    const win = new electron_1.BrowserWindow({\n        ...codexLayout.targetBounds(),\n        show: false,');
  utils=one(utils,'    void win.loadURL(url);\n    return win;','    codexLayout.attach(win);\n    void win.loadURL(url);\n    return win;');
  const oldShow = `const showOrCreateWindow = (port) => {
    const wins = electron_1.BrowserWindow.getAllWindows();
    if (wins.length > 0) {
        if (wins[0].isMinimized()) {
            wins[0].restore();
        }
        wins[0].show();
        wins[0].focus();
    }
    else {
        createWindow(\x60\x24{constants_1.WINDOW_ORIGIN}:\x24{port}/\x60);
    }
};`;
  const newShow = `const showOrCreateWindow = (port) => {
    const win = codexLayout.selectWindow();
    if (win) {
        codexLayout.reveal(win);
    } else {
        createWindow(\x60\x24{constants_1.WINDOW_ORIGIN}:\x24{port}/\x60);
    }
};`;
  utils=one(utils,oldShow,newShow);
  tray=one(tray,"        tray.on('click', onClick);","        tray.on(process.platform === 'win32' ? 'double-click' : 'click', onClick);");
  tray=one(tray,"            countItem.label =\n                (count > 0 ? `${count}` : 'No') +\n                    ' agent' +\n                    (count === 1 ? '' : 's') +\n                    ' running';","            countItem.label = count > 0\n                ? (require(\"./hub-client-settings\").read().localization ? `${count} 个智能体正在运行` : `${count} agent${count === 1 ? '' : 's'} running`)\n                : (require(\"./hub-client-settings\").read().localization ? '没有智能体正在运行' : 'No agents running');");
  return {utils,tray};
}
function patchMain(bytes){
  let main=check('main',bytes);
  // Install after electron-log initialization, so patch failures have durable logs.
  main=one(main,'    Object.assign(console, main_1.default.functions);','    Object.assign(console, main_1.default.functions);\n    require("./hans-main").install(electron_1);');
  for(const [from,to] of [
    ["label: 'No agents running'","label: '没有智能体正在运行'"],
    ['label: `Open ${electron_1.app.getName()}`','label: `打开 ${electron_1.app.getName()}`'],
    ["label: 'Quit'","label: '退出'"],
    ["buttons: ['Cancel', 'Quit']","buttons: ['取消', '退出']"],
    ["title: 'Confirm Quit'","title: '确认退出'"],
    ["message: 'Are you sure you want to quit?'","message: '确定要退出吗？'"],
    ["detail: 'There may be agents or background tasks running.'","detail: '可能仍有智能体或后台任务正在运行。'"]
  ]) {
    const replacement = from.startsWith('label:') ? 'label: ' + '(require("./hub-client-settings").read().localization ? ' + to.slice(7) + ' : ' + from.slice(7) + ')' :
      from.split(':')[0] + ': (require("./hub-client-settings").read().localization ? ' + to.slice(to.indexOf(':')+1).trim() + ' : ' + from.slice(from.indexOf(':')+1).trim() + ')';
    main=one(main,from,replacement);
  }
  return main;
}
function patchMenu(bytes){
  let menu=check('menu',bytes);
  for(const [from,to] of [['New Window','新窗口'],['Docs','文档'],['Connect to WSL','连接到 WSL'],['Reopen Locally','在本机重新打开']])
    menu=one(menu,"label: '"+from+"'", "label: (require(\"./hub-client-settings\").read().localization ? '"+to+"' : '"+from+"')");
  return menu;
}
module.exports={INPUTS,sha,one,check,transform2191,patchMain,patchMenu};
