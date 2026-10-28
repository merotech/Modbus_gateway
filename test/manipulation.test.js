'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DataStore } = require('../src/datastore');
const { applyRule } = require('../src/manipulation');
const { validateConfig } = require('../src/config');
const { Gateway } = require('../src/gateway');
const { handlePdu } = require('../src/slave');
const { writeCoilsRequest } = require('../src/modbus');

test('coils to holding bits, crossing into the next register', () => {
  const store = new DataStore();
  store.holdings[100] = 0xffff;
  store.coils.set([1, 0, 1, 1, 0, 1], 10);
  applyRule(store, { type: 'coilsToHolding', sourceAddress: 10, count: 6, targetAddress: 100, targetBit: 13 });
  // Bits 13,14,15 of H100 get 1,0,1; bits 0,1,2 of H101 get 1,0,1.
  assert.strictEqual(store.holdings[100], 0xbfff);
  assert.strictEqual(store.holdings[101], 0b101);
});

test('holding bits to coils', () => {
  const store = new DataStore();
  store.holdings[5] = 0b1010_0000_0000_0000;
  store.holdings[6] = 0b11;
  applyRule(store, { type: 'holdingBitsToCoils', sourceAddress: 5, sourceBit: 13, count: 5, targetAddress: 0 });
  assert.deepStrictEqual(Array.from(store.coils.subarray(0, 5)), [1, 0, 1, 1, 1]);
});

test('holding bits to holding bits leaves other target bits untouched', () => {
  const store = new DataStore();
  store.holdings[0] = 0x00f0;
  store.holdings[1] = 0x8001;
  applyRule(store, { type: 'holdingBitsToHolding', sourceAddress: 0, sourceBit: 4, count: 4, targetAddress: 1, targetBit: 8 });
  assert.strictEqual(store.holdings[1], 0x8f01);
  // Overlapping source and target copy like memmove, not a forward smear.
  store.holdings[2] = 0b0001;
  applyRule(store, { type: 'holdingBitsToHolding', sourceAddress: 2, sourceBit: 0, count: 4, targetAddress: 2, targetBit: 1 });
  assert.strictEqual(store.holdings[2], 0b0011);
});

test('rule validation', () => {
  const { errors } = validateConfig({
    manipulation: { rules: [
      { type: 'nope', sourceAddress: 0, count: 1, targetAddress: 0, targetBit: 0 },
      { type: 'holdingBitsToHolding', sourceAddress: 65535, sourceBit: 15, count: 2, targetAddress: 0, targetBit: 16 },
      { type: 'coilsToHolding', sourceAddress: 65535, count: 1, targetAddress: 65535, targetBit: 15 },
    ] },
  });
  assert.ok(errors.some((e) => e.startsWith('Manipulation line 1: manipulation type')));
  assert.ok(errors.some((e) => e === 'Manipulation line 2: source range must fit inside 0-65535'));
  assert.ok(errors.some((e) => e === 'Manipulation line 2: target start bit must be 0-15'));
  assert.ok(!errors.some((e) => e.startsWith('Manipulation line 3')));
});

test('a SCADA write triggers the rules immediately, in order', async () => {
  const { config, errors } = validateConfig({
    slave: { port: 15120 },
    masters: [],
    manipulation: { intervalMs: 60000, rules: [
      { type: 'coilsToHolding', sourceAddress: 0, count: 3, targetAddress: 10, targetBit: 4 },
      { type: 'holdingBitsToCoils', sourceAddress: 10, sourceBit: 4, count: 3, targetAddress: 100 },
      { type: 'coilsToHolding', enabled: false, sourceAddress: 0, count: 3, targetAddress: 20, targetBit: 0 },
    ] },
  });
  assert.deepStrictEqual(errors, []);
  const gw = new Gateway();
  await gw.apply(config);
  try {
    handlePdu(gw.store, writeCoilsRequest(0, [1, 1, 0]));
    gw.store.touched();
    assert.strictEqual(gw.store.holdings[10], 0b0011_0000);
    assert.deepStrictEqual(Array.from(gw.store.coils.subarray(100, 103)), [1, 1, 0]);
    assert.strictEqual(gw.store.holdings[20], 0, 'disabled rule does not run');
    assert.strictEqual(gw.status().manipulation.rules.length, 3);
  } finally {
    await gw.stop();
  }
});
