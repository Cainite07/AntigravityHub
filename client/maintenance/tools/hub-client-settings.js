'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const DEFAULTS = Object.freeze({localization:false, thinking:false, customSize:false, width:1400, height:900});
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {...DEFAULTS};
  const width = value.ClientWindowWidth, height = value.ClientWindowHeight;
  const validSize = Number.isInteger(width) && width >= 640 && width <= 7680 &&
    Number.isInteger(height) && height >= 480 && height <= 4320;
  return {
    localization:value.EnableClientLocalization === true,
    thinking:value.EnableThinkingTranslation === true,
    customSize:value.EnableClientWindowSize === true && validSize,
    width:validSize ? width : DEFAULTS.width,
    height:validSize ? height : DEFAULTS.height
  };
}
function read() {
  try {
    const file = path.join(os.homedir(), '.antigravity_hub', 'app_settings.json');
    const stat = fs.statSync(file);
    if (stat.size > 65536) return {...DEFAULTS};
    return normalize(JSON.parse(fs.readFileSync(file,'utf8')));
  } catch { return {...DEFAULTS}; }
}
module.exports = {read, normalize, DEFAULTS};
