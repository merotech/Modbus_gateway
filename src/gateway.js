'use strict';

const { EventEmitter } = require('node:events');
const { DataStore } = require('./datastore');
const { ModbusSlave } = require('./slave');
const { ModbusMaster } = require('./master');
const { applyRule } = require('./manipulation');

// Owns the local data store, the local slave and every master. The data store survives
// config changes so values already scanned are not lost when lines are edited.
class Gateway extends EventEmitter {
  constructor() {
    super();
    this.store = new DataStore();
    this.slave = null;
    this.masters = [];
    this.config = null;
    this.startedAt = Date.now();
    this.rules = [];
    this.ruleRuns = 0;
    this.ruleTimer = null;
    this.store.onWrite = () => this.runRules();
  }

  // Rules run in configured order, so a later rule may consume an earlier rule's output.
  runRules() {
    if (!this.rules.length) return;
    for (const rule of this.rules) applyRule(this.store, rule);
    this.ruleRuns++;
  }

  async apply(config) {
    for (const master of this.masters) master.stop();
    this.masters = [];
    clearInterval(this.ruleTimer);
    this.rules = config.manipulation.rules.filter((r) => r.enabled);
    this.ruleTimer = setInterval(() => this.runRules(), config.manipulation.intervalMs);

    const slaveChanged = !this.slave || !this.config || this.config.slave.port !== config.slave.port;
    if (slaveChanged) {
      if (this.slave) await this.slave.stop();
      this.slave = new ModbusSlave(this.store, { port: config.slave.port, unitId: config.slave.unitId });
      this.slave.on('log', (msg) => this.emit('log', msg));
      await this.slave.start();
    } else {
      this.slave.unitId = config.slave.unitId;
    }

    this.config = config;
    this.masters = config.masters.map((cfg) => {
      const master = new ModbusMaster(cfg, this.store);
      master.on('log', (msg) => this.emit('log', msg));
      master.start();
      return master;
    });
  }

  async stop() {
    clearInterval(this.ruleTimer);
    for (const master of this.masters) master.stop();
    if (this.slave) await this.slave.stop();
  }

  status() {
    return {
      time: Date.now(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      slave: this.slave ? this.slave.status() : null,
      masters: this.masters.map((m) => m.status()),
      manipulation: {
        intervalMs: this.config.manipulation.intervalMs,
        runs: this.ruleRuns,
        rules: this.config.manipulation.rules,
      },
    };
  }
}

module.exports = { Gateway };
