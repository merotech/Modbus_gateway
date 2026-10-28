'use strict';

const fs = require('node:fs');
const path = require('node:path');

// When packaged as a Node single executable (SEA) there is no source tree on disk: the UI
// is embedded as an asset and files the user owns (config, log) live next to the .exe.
let sea = null;
try {
  sea = require('node:sea');
} catch {
  // Node < 20 has no SEA support; always running from source then.
}

function isSea() {
  return Boolean(sea && sea.isSea());
}

function appDir() {
  return isSea() ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

function readAsset(name) {
  if (isSea()) return sea.getAsset(name, 'utf8');
  return fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
}

module.exports = { isSea, appDir, readAsset };
