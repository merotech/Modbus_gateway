'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TYPES: MANIPULATION_TYPES } = require('./manipulation');

const FUNCTIONS = ['readCoils', 'writeCoils', 'readHoldings', 'writeHoldings'];
const HOLDING_BITS = 65536 * 16;

const DEFAULT_CONFIG = {
  uiPassword: 'hotelo',
  web: { port: 8080 },
  slave: { port: 502, unitId: 0 },
  masters: [
    {
      name: 'Client 1',
      enabled: true,
      ip: '192.168.1.10',
      port: 502,
      pollIntervalMs: 1000,
      timeoutMs: 1000,
      writeMode: 'onChange',
      lines: [
        { enabled: true, unitId: 1, function: 'readHoldings', remoteAddress: 0, localAddress: 0, count: 10 },
        { enabled: true, unitId: 1, function: 'writeHoldings', remoteAddress: 100, localAddress: 1000, count: 10 },
      ],
    },
  ],
  manipulation: { intervalMs: 100, rules: [] },
};

function int(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

// Normalises a config object and collects human-readable errors. Never throws.
function validateConfig(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};

  const config = {
    uiPassword: typeof src.uiPassword === 'string' && src.uiPassword ? src.uiPassword : DEFAULT_CONFIG.uiPassword,
    web: { port: int(src.web?.port, 8080) },
    slave: { port: int(src.slave?.port, 502), unitId: int(src.slave?.unitId, 0) },
    masters: [],
  };

  if (config.web.port < 1 || config.web.port > 65535) errors.push('Web port must be 1-65535');
  if (config.slave.port < 1 || config.slave.port > 65535) errors.push('Slave port must be 1-65535');
  if (config.slave.unitId < 0 || config.slave.unitId > 255) errors.push('Slave unit ID must be 0-255');
  if (config.slave.port === config.web.port) errors.push('Slave port and web port must differ');

  const masters = Array.isArray(src.masters) ? src.masters : [];
  masters.forEach((m, mi) => {
    const where = `Client ${mi + 1}`;
    const master = {
      name: String(m?.name ?? '').trim() || `Client ${mi + 1}`,
      enabled: m?.enabled !== false,
      ip: String(m?.ip ?? '').trim(),
      port: int(m?.port, 502),
      pollIntervalMs: int(m?.pollIntervalMs, 1000),
      timeoutMs: int(m?.timeoutMs, 1000),
      writeMode: m?.writeMode === 'everyCycle' ? 'everyCycle' : 'onChange',
      lines: [],
    };
    if (!master.ip) errors.push(`${where}: IP address is required`);
    else if (!/^[A-Za-z0-9.\-:]+$/.test(master.ip)) errors.push(`${where}: invalid IP address "${master.ip}"`);
    if (master.port < 1 || master.port > 65535) errors.push(`${where}: port must be 1-65535`);
    if (master.pollIntervalMs < 50 || master.pollIntervalMs > 3600000) errors.push(`${where}: poll interval must be 50-3600000 ms`);
    if (master.timeoutMs < 50 || master.timeoutMs > 60000) errors.push(`${where}: timeout must be 50-60000 ms`);

    const lines = Array.isArray(m?.lines) ? m.lines : [];
    lines.forEach((l, li) => {
      const at = `${where}, line ${li + 1}`;
      const line = {
        enabled: l?.enabled !== false,
        unitId: int(l?.unitId, 1),
        function: FUNCTIONS.includes(l?.function) ? l.function : null,
        remoteAddress: int(l?.remoteAddress, -1),
        localAddress: int(l?.localAddress, -1),
        count: int(l?.count, 0),
      };
      if (line.unitId < 0 || line.unitId > 255) errors.push(`${at}: Modbus ID must be 0-255`);
      if (!line.function) errors.push(`${at}: transaction type is required`);
      if (line.count < 1 || line.count > 65536) errors.push(`${at}: count must be at least 1`);
      if (line.remoteAddress < 0 || line.remoteAddress + line.count > 65536) {
        errors.push(`${at}: client start address must be 0-65535 and the range must fit below 65536`);
      }
      if (line.localAddress < 0 || line.localAddress + line.count > 65536) {
        errors.push(`${at}: local target address must be 0-65535 and the range must fit below 65536`);
      }
      master.lines.push(line);
    });
    config.masters.push(master);
  });

  config.manipulation = { intervalMs: int(src.manipulation?.intervalMs, 100), rules: [] };
  if (config.manipulation.intervalMs < 10 || config.manipulation.intervalMs > 60000) {
    errors.push('Manipulation interval must be 10-60000 ms');
  }
  const rules = Array.isArray(src.manipulation?.rules) ? src.manipulation.rules : [];
  rules.forEach((r, ri) => {
    const at = `Manipulation line ${ri + 1}`;
    const type = MANIPULATION_TYPES.includes(r?.type) ? r.type : null;
    const fromCoils = type === 'coilsToHolding';
    const toCoils = type === 'holdingBitsToCoils';
    const rule = {
      enabled: r?.enabled !== false,
      type,
      sourceAddress: int(r?.sourceAddress, -1),
      // Coils are addressed one bit per address, so the bit fields only apply to holdings.
      sourceBit: fromCoils ? 0 : int(r?.sourceBit, -1),
      count: int(r?.count, 0),
      targetAddress: int(r?.targetAddress, -1),
      targetBit: toCoils ? 0 : int(r?.targetBit, -1),
    };
    if (!type) errors.push(`${at}: manipulation type is required`);
    if (rule.count < 1 || rule.count > 65536) errors.push(`${at}: number of bits must be 1-65536`);
    if (rule.sourceBit < 0 || rule.sourceBit > 15) errors.push(`${at}: source start bit must be 0-15`);
    if (rule.targetBit < 0 || rule.targetBit > 15) errors.push(`${at}: target start bit must be 0-15`);
    const fits = (address, bit, asCoils) =>
      address >= 0 && address <= 65535 && (asCoils ? address + rule.count <= 65536 : address * 16 + bit + rule.count <= HOLDING_BITS);
    if (!fits(rule.sourceAddress, rule.sourceBit, fromCoils)) errors.push(`${at}: source range must fit inside 0-65535`);
    if (!fits(rule.targetAddress, rule.targetBit, toCoils)) errors.push(`${at}: target range must fit inside 0-65535`);
    config.manipulation.rules.push(rule);
  });

  return { config, errors };
}

function loadConfig(file) {
  if (!fs.existsSync(file)) {
    saveConfig(file, DEFAULT_CONFIG);
    return validateConfig(DEFAULT_CONFIG);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateConfig(raw);
}

// Write-then-rename so a crash mid-save never leaves a truncated config.
function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULT_CONFIG, FUNCTIONS, validateConfig, loadConfig, saveConfig };
