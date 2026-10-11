'use strict';
const marker = '// Codex Antigravity layout policy v1';
function replaceOne(text, before, after) {
    if (text.split(before).length !== 2) throw new Error('Expected source anchor is missing or ambiguous. No changes deployed.');
    return text.replace(before, after);
}

function transform2170(sourceUtils, sourceTray) {
    const newWindow = '    const win = new electron_1.BrowserWindow({\n        width: 1475,\n        height: 875,';
    let utils = replaceOne(sourceUtils, 'const electron_1 = require("electron");', `const electron_1 = require("electron");\n${marker}\nconst codexLayout = require("./codex-layout");`);
    utils = replaceOne(utils, newWindow, '    const win = new electron_1.BrowserWindow({\n        ...codexLayout.targetBounds(),\n        show: false,');
    const lifecycleStart = utils.indexOf("        win.on('restore', () => {");
    const loadStart = utils.indexOf('    void win.loadURL(url);', lifecycleStart);
    if (lifecycleStart < 0 || loadStart < 0) throw new Error('Cannot locate reviewed legacy lifecycle hooks in 2.17.0.');
    utils = utils.slice(0, lifecycleStart) + '    codexLayout.attach(win);\n' + utils.slice(loadStart);
    const showStart = utils.indexOf('const showOrCreateWindow = (port) => {');
    const showEnd = utils.indexOf('exports.showOrCreateWindow = showOrCreateWindow;', showStart);
    if (showStart < 0 || showEnd < 0) throw new Error('Cannot locate window activation function in 2.17.0.');
    utils = utils.slice(0, showStart) + `const showOrCreateWindow = (port) => {
    const win = codexLayout.selectWindow();
    if (win) {
        codexLayout.reveal(win);
    } else {
        createWindow(\x60\x24{constants_1.WINDOW_ORIGIN}:\x24{port}/\x60);
    }
};
` + utils.slice(showEnd);

    const trayStart = sourceTray.indexOf('        contextMenu = electron_1.Menu.buildFromTemplate(actions);');
    const trayEnd = sourceTray.indexOf('\n}\n', trayStart);
    if (trayStart < 0 || trayEnd < 0) throw new Error('Cannot locate tray initialization in 2.17.0.');
    let tray = sourceTray.slice(0, trayStart) + `    ${marker}
    contextMenu = electron_1.Menu.buildFromTemplate(actions);
    tray.setContextMenu(contextMenu);
    if (process.platform === 'win32') {
        tray.on('double-click', () => {
            (0, utils_1.showOrCreateWindow)((0, languageServer_1.getLsPort)());
        });
    }
` + sourceTray.slice(trayEnd);
    tray = replaceOne(tray, `                        if ((0, utils_1.isMacOS)()) {
                tray.setContextMenu(contextMenu);
            }`, '            tray.setContextMenu(contextMenu);');

    return { utils, tray };
}

function transform2181(sourceUtils, sourceTray) {
    let utils = replaceOne(sourceUtils, 'const electron_1 = require("electron");', `const electron_1 = require("electron");\n${marker}\nconst codexLayout = require("./codex-layout");`);
    const newWindow = '    const win = new electron_1.BrowserWindow({\n        width: 1400,\n        height: 900,';
    utils = replaceOne(utils, newWindow, '    const win = new electron_1.BrowserWindow({\n        ...codexLayout.targetBounds(),\n        show: false,');
    utils = replaceOne(utils, '    void win.loadURL(url);\n    return win;', '    codexLayout.attach(win);\n    void win.loadURL(url);\n    return win;');
    
    const showStart = utils.indexOf('const showOrCreateWindow = (port) => {');
    const showEnd = utils.indexOf('exports.showOrCreateWindow = showOrCreateWindow;', showStart);
    if (showStart < 0 || showEnd < 0) throw new Error('Cannot locate window activation function in 2.18.1.');
    utils = utils.slice(0, showStart) + `const showOrCreateWindow = (port) => {
    const win = codexLayout.selectWindow();
    if (win) {
        codexLayout.reveal(win);
    } else {
        createWindow(\x60\x24{constants_1.WINDOW_ORIGIN}:\x24{port}/\x60);
    }
};
` + utils.slice(showEnd);

    let tray = replaceOne(sourceTray, 'const utils_1 = require("./utils");', 'const utils_1 = require("./utils");\nconst languageServer_1 = require("./languageServer");');
    const targetInit = '    contextMenu = electron_1.Menu.buildFromTemplate(actions);\n    tray.setContextMenu(contextMenu);\n}';
    const replaceInit = `    ${marker}
    contextMenu = electron_1.Menu.buildFromTemplate(actions);
    tray.setContextMenu(contextMenu);
    if (process.platform === 'win32') {
        tray.on('double-click', () => {
            (0, utils_1.showOrCreateWindow)((0, languageServer_1.getLsPort)());
        });
    }
}`;
    tray = replaceOne(tray, targetInit, replaceInit);

    return { utils, tray };
}


module.exports = { transform2170, transform2181 };
