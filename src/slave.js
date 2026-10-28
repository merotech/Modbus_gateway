'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { FC, FrameReader, encodeAdu, packBits, unpackBits } = require('./modbus');

function exception(fc, code) {
  return Buffer.from([fc | 0x80, code]);
}

// Serves the shared DataStore to SCADA/HMI clients. Returns a response PDU or null (no reply).
function handlePdu(store, pdu) {
  const fc = pdu[0];
  if (pdu.length < 5) return exception(fc, 3);
  const address = pdu.readUInt16BE(1);
  const value = pdu.readUInt16BE(3);

  switch (fc) {
    case FC.READ_COILS:
    case FC.READ_DISCRETE_INPUTS: {
      if (value < 1 || value > 2000) return exception(fc, 3);
      if (address + value > 65536) return exception(fc, 2);
      const bits = packBits(store.coils.subarray(address, address + value));
      return Buffer.concat([Buffer.from([fc, bits.length]), bits]);
    }
    case FC.READ_HOLDING_REGISTERS:
    case FC.READ_INPUT_REGISTERS: {
      if (value < 1 || value > 125) return exception(fc, 3);
      if (address + value > 65536) return exception(fc, 2);
      const out = Buffer.alloc(2 + value * 2);
      out[0] = fc;
      out[1] = value * 2;
      for (let i = 0; i < value; i++) out.writeUInt16BE(store.holdings[address + i], 2 + i * 2);
      return out;
    }
    case FC.WRITE_SINGLE_COIL:
      if (value !== 0xff00 && value !== 0x0000) return exception(fc, 3);
      store.coils[address] = value ? 1 : 0;
      return Buffer.from(pdu.subarray(0, 5));
    case FC.WRITE_SINGLE_REGISTER:
      store.holdings[address] = value;
      return Buffer.from(pdu.subarray(0, 5));
    case FC.WRITE_MULTIPLE_COILS: {
      const byteCount = pdu[5];
      if (value < 1 || value > 1968 || byteCount !== Math.ceil(value / 8) || pdu.length < 6 + byteCount) {
        return exception(fc, 3);
      }
      if (address + value > 65536) return exception(fc, 2);
      store.coils.set(unpackBits(pdu.subarray(6), value), address);
      return Buffer.from(pdu.subarray(0, 5));
    }
    case FC.WRITE_MULTIPLE_REGISTERS: {
      const byteCount = pdu[5];
      if (value < 1 || value > 123 || byteCount !== value * 2 || pdu.length < 6 + byteCount) {
        return exception(fc, 3);
      }
      if (address + value > 65536) return exception(fc, 2);
      for (let i = 0; i < value; i++) store.holdings[address + i] = pdu.readUInt16BE(6 + i * 2);
      return Buffer.from(pdu.subarray(0, 5));
    }
    default:
      return exception(fc, 1);
  }
}

class ModbusSlave extends EventEmitter {
  constructor(store, { host = '0.0.0.0', port = 502, unitId = 0 } = {}) {
    super();
    this.store = store;
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.clients = new Map();
    this.server = null;
    this.state = 'stopped';
    this.lastError = null;
    this.requests = 0;
  }

  start() {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => this._accept(socket));
      this.server.on('error', (err) => {
        this.state = 'error';
        this.lastError = err.message;
        this.emit('log', `Slave listen error on port ${this.port}: ${err.message}`);
        resolve(false);
      });
      this.server.listen(this.port, this.host, () => {
        this.state = 'listening';
        this.lastError = null;
        this.emit('log', `Slave listening on ${this.host}:${this.port}`);
        resolve(true);
      });
    });
  }

  stop() {
    for (const socket of this.clients.keys()) socket.destroy();
    this.clients.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
      this.state = 'stopped';
    });
  }

  _accept(socket) {
    const info = {
      address: `${socket.remoteAddress}:${socket.remotePort}`.replace(/^::ffff:/, ''),
      connectedAt: Date.now(),
      requests: 0,
      lastRequestAt: null,
    };
    this.clients.set(socket, info);
    this.emit('log', `Slave: client connected ${info.address}`);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    const reader = new FrameReader((frame) => {
      // unitId 0 means "answer any unit id"; TCP clients commonly send 0, 1 or 255.
      if (this.unitId && frame.unitId !== this.unitId) return;
      info.requests++;
      info.lastRequestAt = Date.now();
      this.requests++;
      const response = handlePdu(this.store, frame.pdu);
      if (response) socket.write(encodeAdu(frame.transactionId, frame.unitId, response));
      // FC 5, 6, 15 and 16 are the writes; an exception response means nothing changed.
      if (response && frame.pdu[0] >= 5 && !(response[0] & 0x80)) this.store.touched();
    });

    socket.on('data', (chunk) => {
      if (!reader.push(chunk)) socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.clients.delete(socket);
      this.emit('log', `Slave: client disconnected ${info.address}`);
    });
  }

  status() {
    return {
      state: this.state,
      host: this.host,
      port: this.port,
      unitId: this.unitId,
      lastError: this.lastError,
      requests: this.requests,
      clients: [...this.clients.values()],
    };
  }
}

module.exports = { ModbusSlave, handlePdu };
