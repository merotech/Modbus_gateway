'use strict';

// Builds dist/ModbusGateway/modbus-gateway.exe as a Node single executable application and
// zips it with the Windows installer scripts. Run on Windows with the Node version you want
// to ship: the exe is a copy of the running node.exe with the gateway injected.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const OUT = path.join(ROOT, 'dist', 'ModbusGateway');
const EXE = path.join(OUT, 'modbus-gateway.exe');
const POSTJECT = 'postject@1.0.0-alpha.6';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const { version } = require('../package.json');

function step(msg) {
  console.log(`\n> ${msg}`);
}

// SEA only runs a single CommonJS file and its require() reaches built-in modules only, so
// every src/ module is wrapped into one file with a tiny local module loader.
function bundle() {
  const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
  const defs = files.map((f) => {
    const id = `src/${f}`;
    const code = fs.readFileSync(path.join(ROOT, id), 'utf8').replace(/^#!.*\n/, '');
    return `${JSON.stringify(id)}: function (module, exports, require, __filename, __dirname) {\n${code}\n}`;
  });
  return `'use strict';
const __defs = {\n${defs.join(',\n')}\n};
const __cache = {};
const __path = require('node:path');
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  const module = { exports: {} };
  __cache[id] = module;
  const dir = __path.posix.dirname(id);
  const localRequire = (request) => {
    if (!request.startsWith('./') && !request.startsWith('../')) return require(request);
    let target = __path.posix.normalize(__path.posix.join(dir, request));
    if (!target.endsWith('.js')) target += '.js';
    if (!__defs[target]) throw new Error('Module missing from bundle: ' + target);
    return __load(target);
  };
  __defs[id].call(module.exports, module, module.exports, localRequire, id, dir);
  return module.exports;
}
__load('src/index.js');
`;
}

if (process.platform !== 'win32') {
  console.error('Build the Windows executable on Windows.');
  process.exit(1);
}

fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

step('Bundling src/');
fs.writeFileSync(path.join(BUILD, 'bundle.js'), bundle());

step('Generating SEA blob');
const seaConfig = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(BUILD, 'bundle.js'),
      output: path.join(BUILD, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      assets: { 'index.html': path.join(ROOT, 'public', 'index.html') },
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

step(`Creating ${path.relative(ROOT, EXE)} from node ${process.version}`);
fs.copyFileSync(process.execPath, EXE);
// The copied node.exe carries Node's Authenticode signature, which the injection invalidates.
// Strip it when signtool is around; the exe runs either way.
try {
  execFileSync('signtool', ['remove', '/s', EXE], { stdio: 'ignore' });
} catch {
  console.log('  (signtool not found; leaving the original signature in place)');
}
execSync(`npx --yes ${POSTJECT} "${EXE}" NODE_SEA_BLOB "${path.join(BUILD, 'sea-prep.blob')}" --sentinel-fuse ${SEA_FUSE}`, {
  stdio: 'inherit',
});

step('Adding installer files');
for (const f of fs.readdirSync(path.join(ROOT, 'installer'))) {
  fs.copyFileSync(path.join(ROOT, 'installer', f), path.join(OUT, f));
}

step('Zipping');
const zip = path.join(ROOT, 'dist', `ModbusGateway-${version}-win-x64.zip`);
execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -Force`], {
  stdio: 'inherit',
});

console.log(`\nDone:\n  ${EXE}\n  ${zip}`);
