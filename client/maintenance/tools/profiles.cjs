'use strict';
const fs = require('node:fs'), path = require('node:path');
const profiles = ['unified-profile.json', 'unified-profile-2.23.0.json']
  .filter(file => fs.existsSync(path.join(__dirname, file)))
  .map(file => ({ file, ...JSON.parse(fs.readFileSync(path.join(__dirname, file))) }));
function forVersion(version) { return profiles.find(profile => profile.version === version) || null; }
module.exports = { profiles, forVersion };
