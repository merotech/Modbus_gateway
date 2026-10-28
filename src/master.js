'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const {
  FC,
  LIMITS,
  FrameReader,
  encodeAdu,
  readRequest,
  writeCoilsRequest,
  writeRegistersRequest,
  parseResponse,
} = require('./modbus');

const RECONNECT_DELAY_MS = 3000;
// Consecutive timeouts tolerated before the socket is assumed dead. A single timeout is
// often one offline unit behind an RTU gateway, so reconnecting on the first is too eager.
const MAX_CONSECUTIVE_TIMEOUTS = 5;
const PREVIEW_VALUES = 16;

function sameValues(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// One Modbus TCP master: a single connection to one client device, scanning its lines
// in order every poll cycle. Requests are strictly sequential (one outstanding) because
// many devices and serial gateways mishandle pipelined requests.
class ModbusMaster extends EventEmitter {
  constructor(config, store) {
    super();
    this.config = config;
    this.store = store;
    this.socket = null;
    this.reader = null;
    this.pending = null;
    this.transactionId = 0;
    this.running = false;
    this.wake = null;
    this.consecutiveTimeouts = 0;
    this.state = config.enabled ? 'stopped' : 'disabled';
    this.lastError = null;
    this.connectedSince = null;
    this.cycles = 0;
    this.cycleMs = null;
    this.lines = config.lines.map((line) => ({
      status: line.enabled ? 'pending' : 'disabled',
      okCount: 0,
      errorCount: 0,
      lastError: null,
      lastOkAt: null,
      responseMs: null,
      values: [],
      lastWritten: null,
    }));
  }

  start() {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    this._loop().catch((err) => this.emit('log', `${this.label()}: loop crashed: ${err.stack || err}`));
  }

  stop() {
    this.running = false;
    this._disconnect('stopped');
    if (this.wake) this.wake();
    this.state = this.config.enabled ? 'stopped' : 'disabled';
  }

  label() {
    return `Master "${this.config.name || this.config.ip}" (${this.config.ip}:${this.config.port})`;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  async _loop() {
    while (this.running) {
      const started = Date.now();
      if (!this.socket) {
        try {
          await this._connect();
        } catch (err) {
          if (!this.running) break;
          this.state = 'error';
          this.lastError = `Connect failed: ${err.message}`;
          for (const line of this.lines) if (line.status !== 'disabled') line.status = 'offline';
          await this._sleep(RECONNECT_DELAY_MS);
          continue;
        }
        // stop() may have run while the connect was in flight.
        if (!this.running) {
          this._disconnect('stopped');
          break;
        }
      }

      for (let i = 0; i < this.config.lines.length && this.running && this.socket; i++) {
        if (this.config.lines[i].enabled) await this._runLine(i);
      }

      if (!this.running) break;
      this.cycles++;
      this.cycleMs = Date.now() - started;
      await this._sleep(Math.max(10, this.config.pollIntervalMs - this.cycleMs));
    }
  }

  _connect() {
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.config.ip, port: this.config.port });
      const connectTimer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timeout'));
      }, Math.max(this.config.timeoutMs, 2000));

      socket.once('connect', () => {
        clearTimeout(connectTimer);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10000);
        this.socket = socket;
        this.reader = new FrameReader((frame) => this._onFrame(frame));
        this.state = 'connected';
        this.lastError = null;
        this.connectedSince = Date.now();
        this.consecutiveTimeouts = 0;
        // A reconnect may mean the device restarted, so every write line is resent.
        for (const line of this.lines) line.lastWritten = null;
        this.emit('log', `${this.label()}: connected`);
        resolve();
      });
      socket.on('data', (chunk) => {
        if (this.socket === socket && !this.reader.push(chunk)) this._disconnect('framing error');
      });
      socket.on('error', (err) => {
        clearTimeout(connectTimer);
        if (this.socket === socket) this.lastError = err.message;
        reject(err);
      });
      socket.on('close', () => {
        if (this.socket === socket) this._disconnect('connection closed');
      });
    });
  }

  _disconnect(reason) {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.reader = null;
    this.connectedSince = null;
    socket.destroy();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
    if (this.running) {
      this.state = 'error';
      this.lastError = this.lastError || reason;
      this.emit('log', `${this.label()}: disconnected (${reason})`);
    }
  }

  _onFrame(frame) {
    // Responses for requests that already timed out carry an old transaction id; drop them.
    if (!this.pending || frame.transactionId !== this.pending.transactionId) return;
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    resolve(frame.pdu);
  }

  _request(unitId, pdu) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('not connected'));
      this.transactionId = (this.transactionId + 1) & 0xffff;
      const transactionId = this.transactionId;
      const timer = setTimeout(() => {
        if (this.pending && this.pending.transactionId === transactionId) this.pending = null;
        reject(new Error('Timeout'));
      }, this.config.timeoutMs);
      this.pending = { transactionId, resolve, reject, timer };
      this.socket.write(encodeAdu(transactionId, unitId, pdu));
    }).then(
      (response) => {
        this.consecutiveTimeouts = 0;
        return parseResponse(pdu, response);
      },
      (err) => {
        if (err.message === 'Timeout' && ++this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          this._disconnect('too many timeouts');
        }
        throw err;
      },
    );
  }

  async _runLine(index) {
    const line = this.config.lines[index];
    const state = this.lines[index];
    const started = Date.now();
    try {
      switch (line.function) {
        case 'readCoils':
          await this._read(line, FC.READ_COILS, LIMITS.readCoils, this.store.coils);
          state.values = Array.from(this.store.coils.subarray(line.localAddress, line.localAddress + PREVIEW_VALUES));
          break;
        case 'readHoldings':
          await this._read(line, FC.READ_HOLDING_REGISTERS, LIMITS.readHoldings, this.store.holdings);
          state.values = Array.from(this.store.holdings.subarray(line.localAddress, line.localAddress + PREVIEW_VALUES));
          break;
        case 'writeCoils':
        case 'writeHoldings': {
          const isCoils = line.function === 'writeCoils';
          const table = isCoils ? this.store.coils : this.store.holdings;
          const current = Array.from(table.subarray(line.localAddress, line.localAddress + line.count));
          state.values = current.slice(0, PREVIEW_VALUES);
          if (this.config.writeMode !== 'everyCycle' && sameValues(state.lastWritten, current)) {
            state.status = 'ok';
            return;
          }
          const limit = isCoils ? LIMITS.writeCoils : LIMITS.writeHoldings;
          for (let offset = 0; offset < line.count; offset += limit) {
            const chunk = current.slice(offset, offset + limit);
            const address = line.remoteAddress + offset;
            const pdu = isCoils ? writeCoilsRequest(address, chunk) : writeRegistersRequest(address, chunk);
            await this._request(line.unitId, pdu);
          }
          state.lastWritten = current;
          break;
        }
        default:
          throw new Error(`Unknown transaction type ${line.function}`);
      }
      state.status = 'ok';
      state.okCount++;
      state.lastOkAt = Date.now();
      state.lastError = null;
      state.responseMs = Date.now() - started;
    } catch (err) {
      state.status = 'error';
      state.errorCount++;
      state.lastError = err.message;
      state.responseMs = null;
    }
  }

  async _read(line, fc, limit, table) {
    for (let offset = 0; offset < line.count; offset += limit) {
      const quantity = Math.min(limit, line.count - offset);
      const values = await this._request(line.unitId, readRequest(fc, line.remoteAddress + offset, quantity));
      table.set(values, line.localAddress + offset);
    }
    this.store.touched();
  }

  status() {
    return {
      name: this.config.name,
      ip: this.config.ip,
      port: this.config.port,
      enabled: this.config.enabled,
      pollIntervalMs: this.config.pollIntervalMs,
      state: this.state,
      lastError: this.lastError,
      connectedSince: this.connectedSince,
      cycles: this.cycles,
      cycleMs: this.cycleMs,
      lines: this.config.lines.map((line, i) => {
        const { lastWritten, ...state } = this.lines[i];
        return { ...line, ...state };
      }),
    };
  }
}

module.exports = { ModbusMaster };
