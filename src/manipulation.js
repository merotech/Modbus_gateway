'use strict';

// Bit-level copy rules over the local slave's memory. Holding registers are treated as one
// continuous bit stream: bit b of register r is stream position r*16 + b (bit 0 = LSB), so a
// range that runs past bit 15 continues into bit 0 of the next register.

const TYPES = ['coilsToHolding', 'holdingBitsToCoils', 'holdingBitsToHolding'];

function getHoldingBit(holdings, address, bit) {
  const pos = address * 16 + bit;
  return (holdings[pos >> 4] >> (pos & 15)) & 1;
}

function setHoldingBit(holdings, address, bit, value) {
  const pos = address * 16 + bit;
  if (value) holdings[pos >> 4] |= 1 << (pos & 15);
  else holdings[pos >> 4] &= ~(1 << (pos & 15));
}

function applyRule(store, rule) {
  const { count } = rule;
  // Sources are read in full before any write so overlapping source/target ranges behave
  // like a copy rather than smearing bits forward.
  let bits;
  switch (rule.type) {
    case 'coilsToHolding':
      bits = store.coils.slice(rule.sourceAddress, rule.sourceAddress + count);
      for (let i = 0; i < count; i++) setHoldingBit(store.holdings, rule.targetAddress, rule.targetBit + i, bits[i]);
      break;
    case 'holdingBitsToCoils':
      for (let i = 0; i < count; i++) {
        store.coils[rule.targetAddress + i] = getHoldingBit(store.holdings, rule.sourceAddress, rule.sourceBit + i);
      }
      break;
    case 'holdingBitsToHolding':
      bits = new Uint8Array(count);
      for (let i = 0; i < count; i++) bits[i] = getHoldingBit(store.holdings, rule.sourceAddress, rule.sourceBit + i);
      for (let i = 0; i < count; i++) setHoldingBit(store.holdings, rule.targetAddress, rule.targetBit + i, bits[i]);
      break;
    default:
      throw new Error(`Unknown manipulation type ${rule.type}`);
  }
}

module.exports = { TYPES, applyRule, getHoldingBit, setHoldingBit };
