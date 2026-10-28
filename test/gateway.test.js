'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { startSimulator } = require('./sim-slave');
const { Gateway } = require('../src/gateway');
const { validateConfig } = require('../src/config');
const { FrameReader, encodeAdu, readRequest, writeRegistersRequest, writeCoilsRequest, parseResponse } = require('../src/modbus');

const GW_PORT = 15020;

// Minimal one-shot client used to play the SCADA role against the gateway's slave.
function scada(port) {
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  let pending = null;
  let tid = 0;
  const reader = new FrameReader((f) => pending && pending(f.pdu));
  socket.on('data', (c) => reader.push(c));
  const ready = new Promise((r) => socket.once('connect', r));
  return {
    async call(pdu) {
      await ready;
      return new Promise((resolve, reject) => {
        pending = (resp) => {
          try { resolve(parseResponse(pdu, resp)); } catch (e) { reject(e); }
        };
        socket.write(encodeAdu(++tid, 1, pdu));
      });
    },
    close: () => socket.destroy(),
  };
}

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('gateway reads from and writes to several client devices', async () => {
  const devA = await startSimulator(15021);
  const devB = await startSimulator(15022);
  devB.store.coils.set([1, 0, 1, 1, 0, 0, 0, 1, 1], 20);
  // Larger than one FC3 frame (125) so chunking is exercised.
  for (let i = 0; i < 300; i++) devA.store.holdings[1000 + i] = i;

  const { config, errors } = validateConfig({
    slave: { port: GW_PORT },
    web: { port: 15080 },
    masters: [
      {
        name: 'A', ip: '127.0.0.1', port: 15021, pollIntervalMs: 100, timeoutMs: 500,
        lines: [
          { unitId: 1, function: 'readHoldings', remoteAddress: 0, localAddress: 0, count: 10 },
          { unitId: 1, function: 'readHoldings', remoteAddress: 1000, localAddress: 2000, count: 300 },
          { unitId: 1, function: 'writeHoldings', remoteAddress: 500, localAddress: 100, count: 5 },
        ],
      },
      {
        name: 'B', ip: '127.0.0.1', port: 15022, pollIntervalMs: 100, timeoutMs: 500,
        lines: [
          { unitId: 3, function: 'readCoils', remoteAddress: 20, localAddress: 10, count: 9 },
          { unitId: 3, function: 'writeCoils', remoteAddress: 0, localAddress: 50, count: 3 },
        ],
      },
      { name: 'Dead', ip: '127.0.0.1', port: 15029, pollIntervalMs: 100, timeoutMs: 200, lines: [
        { unitId: 1, function: 'readHoldings', remoteAddress: 0, localAddress: 9000, count: 1 },
      ] },
    ],
  });
  assert.deepStrictEqual(errors, []);

  const gw = new Gateway();
  await gw.apply(config);
  const client = scada(GW_PORT);
  try {
    assert.ok(await until(() => gw.store.holdings[0] === 210), 'dev A holdings reached local slave');
    assert.deepStrictEqual(await client.call(readRequest(3, 0, 3)), [210, 211, 212]);
    assert.ok(await until(() => gw.store.holdings[2299] === 299), 'chunked 300-register read');
    assert.deepStrictEqual(await client.call(readRequest(1, 10, 9)), [1, 0, 1, 1, 0, 0, 0, 1, 1]);

    // SCADA writes into the local slave; the masters push those values to the devices.
    await client.call(writeRegistersRequest(100, [11, 22, 33, 44, 55]));
    await client.call(writeCoilsRequest(50, [1, 1, 0]));
    assert.ok(await until(() => devA.store.holdings[504] === 55), 'holdings written to dev A');
    assert.ok(await until(() => devB.store.coils[0] === 1 && devB.store.coils[1] === 1), 'coils written to dev B');

    const st = gw.status();
    assert.strictEqual(st.masters[0].state, 'connected');
    assert.strictEqual(st.masters[1].state, 'connected');
    assert.ok(st.masters[0].lines.every((l) => l.status === 'ok'));
    assert.ok(await until(() => gw.status().masters[2].state === 'error'), 'unreachable client reported');
    assert.strictEqual(st.slave.clients.length, 1);
  } finally {
    client.close();
    await gw.stop();
    await devA.slave.stop();
    await devB.slave.stop();
  }
});

test('config validation rejects bad lines', () => {
  const { errors } = validateConfig({
    masters: [{ ip: '', lines: [{ unitId: 300, function: 'bogus', remoteAddress: 65535, localAddress: 0, count: 5 }] }],
  });
  assert.ok(errors.some((e) => e.includes('IP address is required')));
  assert.ok(errors.some((e) => e.includes('Modbus ID')));
  assert.ok(errors.some((e) => e.includes('transaction type')));
  assert.ok(errors.some((e) => e.includes('client start address')));
});
