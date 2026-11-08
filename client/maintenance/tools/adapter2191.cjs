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
const REVIEWED_INPUTS = {
  preload: ['81d220de63447d27db95adf67d9711b59ee317b2338ba538f419b354a54b1f60','9f3a99cd4a85203dd1ce6f6f07b6463684c39173c91522e6765459361903082d','1b702d07b8415afdb41d27d62515fa88ce91d31dbc15e9dc6cc7ae80dddb0c7b','2f4348c24fa6feeba6fef81644603304667b43a446b3887370781e90ec37ca2c'],
  main: ['afadfbb9c0880f081dd763caa2b9525b2590631ab8fd58cd82e2d67075df1a42','66535c0baffe1c0e3a71e9980c198bceb746bdd733df3e528e2452574f2691d0','66fa884c96dee5dd6a536711d35fc90fee853e9a2eede40fb4d1ab576e4ea50f','e5bf4ae92a586b222034c7de27e0e58dd8922deb0edc9649d290bc06182b2c6c'],
  menu: ['908318fecf7b99c1ae26dbf25ef9cbf05221ebec04f20bca81d059baa337e186','5f09ce9cec448c6ffeb30d2c58daf2d671a09ee03c7ebdaf784f1b61754225e8'],
  utils: ['38bfb7a46abb219ec4f0a76dbd2f79c0f0f9161181ea84ff6874bbefd5bb36fb','2f39dd7b944436bd5007297ccc15c42c897d8e6cecd5a0af93bdf6bfc1708b12','277c626bedc704f12927eee26836350078835eb43ae1847cdc346b0be21b2d9d']
};
function check(name,bytes){if(![INPUTS[name],...(REVIEWED_INPUTS[name]||[])].includes(sha(bytes)))throw Error('Unreviewed client module: '+name);return bytes.toString().replace(/\r\n/g,'\n');}
function transform2191(utilsBytes,trayBytes){
  let utils=check('utils',utilsBytes),tray=check('tray',trayBytes);
  utils=one(utils,'const electron_1 = require("electron");','const electron_1 = require("electron");\n// Codex unified Antigravity 2.19.1 window policy\nconst codexLayout = require("./codex-layout");');
  const nativeState=utils.includes('windowState_1.resolveInitialWindowState');
  if(nativeState) {
    // Upstream owns restore/cascade for both BrowserWindow and WebContentsView.
    // Only the user's explicit size override supersedes its initial state.
    utils=one(utils,'const initialWindowState = (0, windowState_1.resolveInitialWindowState)({',
      'const initialWindowState = codexLayout.initialState((0, windowState_1.resolveInitialWindowState)({');
    utils=one(utils,'            : undefined,\n    });\n    const theme =',
      '            : undefined,\n    }));\n    const theme =');
  } else {
    utils=one(utils,'    const win = new electron_1.BrowserWindow({\n        width: 1400,\n        height: 900,','    const win = new electron_1.BrowserWindow({\n        ...codexLayout.targetBounds(),\n        show: false,');
  }
  const attach=nativeState?'codexLayout.attach(win, { nativeVisibility: true });':'codexLayout.attach(win);';
  utils=one(utils,'    void win.loadURL(url);','    '+attach+'\n    void win.loadURL(url);');
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
  utils=one(utils,utils.includes('const wins = getHubWindows();') ? oldShow.replace('electron_1.BrowserWindow.getAllWindows()', 'getHubWindows()') : oldShow,newShow);
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
