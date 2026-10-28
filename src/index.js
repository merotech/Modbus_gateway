#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('./config');
const { Gateway } = require('./gateway');
const { createWebServer } = require('./web');
const { isSea, appDir } = require('./runtime');

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const RESTART_DELAY_MS = 3000;

// A SEA puts the executable path in argv[1] as well, so user arguments start at 2 either way.
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const logFile = argValue('--log') ? path.resolve(argValue('--log')) : null;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    // Logging must never take the gateway down.
  }
}

// --service: stay resident as a watchdog and restart the gateway if it ever exits. Used when
// running under Task Scheduler, which cannot restart a process that dies after starting.
function supervise() {
  const childArgs = args.filter((a) => a !== '--service');
  const argv = isSea() ? childArgs : [process.argv[1], ...childArgs];
  const run = () => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    child.on('exit', (code, signal) => {
      log(`Gateway process exited (${signal || code}); restarting in ${RESTART_DELAY_MS / 1000} s`);
      setTimeout(run, RESTART_DELAY_MS);
    });
  };
  log('Watchdog started');
  run();
}

async function main() {
  if (args.includes('--service')) return supervise();
  // Killing the watchdog (e.g. stopping the scheduled task) does not kill children on
  // Windows; the closed IPC channel is the signal to exit with it.
  if (process.send) process.on('disconnect', () => process.exit(0));

  const configFile = path.resolve(argValue('--config') || path.join(appDir(), 'config.json'));

  const { config, errors } = loadConfig(configFile);
  if (errors.length) {
    for (const e of errors) log(`Config error: ${e}`);
    process.exit(1);
  }
  log(`Using configuration ${configFile}`);

  const gateway = new Gateway();
  gateway.on('log', log);
  await gateway.apply(config);

  const web = createWebServer({ gateway, configFile, log });
  web.listen(config.web.port, () => log(`Web UI on http://localhost:${config.web.port}`));
  web.on('error', (err) => {
    log(`Web UI failed on port ${config.web.port}: ${err.message}`);
    process.exit(1);
  });

  const shutdown = async () => {
    log('Shutting down');
    web.close();
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log(err.stack || String(err));
  process.exit(1);
});
