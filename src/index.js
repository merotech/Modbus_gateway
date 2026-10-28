#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadConfig } = require('./config');
const { Gateway } = require('./gateway');
const { createWebServer } = require('./web');

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function main() {
  const argIndex = process.argv.indexOf('--config');
  const configFile = path.resolve(argIndex > 0 ? process.argv[argIndex + 1] : path.join(__dirname, '..', 'config.json'));

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
