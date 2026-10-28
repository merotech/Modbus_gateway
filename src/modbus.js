'use strict';

// Modbus TCP framing and PDU helpers shared by the local slave and the masters.
// Addresses are protocol (0-based) addresses throughout.

const FC = {
  READ_COILS: 1,
  READ_DISCRETE_INPUTS: 2,
  READ_HOLDING_REGISTERS: 3,
  READ_INPUT_REGISTERS: 4,
  WRITE_SINGLE_COIL: 5,
  WRITE_SINGLE_REGISTER: 6,
  WRITE_MULTIPLE_COILS: 15,
  WRITE_MULTIPLE_REGISTERS: 16,
};

const EXCEPTION_TEXT = {
  1: 'Illegal function',
  2: 'Illegal data address',
  3: 'Illegal data value',
  4: 'Server device failure',
  5: 'Acknowledge',
  6: 'Server device busy',
  10: 'Gateway path unavailable',
  11: 'Gateway target device failed to respond',
};

// Per-request quantity limits from the Modbus application protocol spec.
const LIMITS = {
  readCoils: 2000,
  writeCoils: 1968,
  readHoldings: 125,
  writeHoldings: 123,
};

class ModbusException extends Error {
  constructor(code) {
    super(`Exception ${code}: ${EXCEPTION_TEXT[code] || 'Unknown'}`);
    this.code = code;
  }
}

function packBits(values) {
  const buf = Buffer.alloc(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) if (values[i]) buf[i >> 3] |= 1 << (i & 7);
  return buf;
}

function unpackBits(buf, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = (buf[i >> 3] >> (i & 7)) & 1;
  return out;
}

function encodeAdu(transactionId, unitId, pdu) {
  const header = Buffer.alloc(7);
  header.writeUInt16BE(transactionId & 0xffff, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(pdu.length + 1, 4);
  header.writeUInt8(unitId & 0xff, 6);
  return Buffer.concat([header, pdu]);
}

// Reassembles MBAP frames from a TCP stream (frames may be split or coalesced).
class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
  }

  // Returns false on a framing error; the caller should drop the connection.
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 7) {
      const protocolId = this.buf.readUInt16BE(2);
      const length = this.buf.readUInt16BE(4);
      if (protocolId !== 0 || length < 2 || length > 254) return false;
      const total = 6 + length;
      if (this.buf.length < total) break;
      const frame = {
        transactionId: this.buf.readUInt16BE(0),
        unitId: this.buf.readUInt8(6),
        pdu: this.buf.subarray(7, total),
      };
      this.buf = this.buf.subarray(total);
      this.onFrame(frame);
    }
    return true;
  }
}

function readRequest(fc, address, quantity) {
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(fc, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(quantity, 3);
  return pdu;
}

function writeCoilsRequest(address, values) {
  const bits = packBits(values);
  const pdu = Buffer.alloc(6 + bits.length);
  pdu.writeUInt8(FC.WRITE_MULTIPLE_COILS, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(values.length, 3);
  pdu.writeUInt8(bits.length, 5);
  bits.copy(pdu, 6);
  return pdu;
}

function writeRegistersRequest(address, values) {
  const pdu = Buffer.alloc(6 + values.length * 2);
  pdu.writeUInt8(FC.WRITE_MULTIPLE_REGISTERS, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(values.length, 3);
  pdu.writeUInt8(values.length * 2, 5);
  for (let i = 0; i < values.length; i++) pdu.writeUInt16BE(values[i] & 0xffff, 6 + i * 2);
  return pdu;
}

// Validates a response PDU against the request it answers; returns read values or true.
function parseResponse(request, pdu) {
  const fc = request[0];
  if (pdu.length < 2) throw new Error('Short response');
  if (pdu[0] === (fc | 0x80)) throw new ModbusException(pdu[1]);
  if (pdu[0] !== fc) throw new Error(`Unexpected function code ${pdu[0]} (expected ${fc})`);
  const quantity = request.readUInt16BE(3);
  switch (fc) {
    case FC.READ_COILS:
    case FC.READ_DISCRETE_INPUTS: {
      const byteCount = pdu[1];
      if (byteCount < Math.ceil(quantity / 8) || pdu.length < 2 + byteCount) throw new Error('Bad coil byte count');
      return unpackBits(pdu.subarray(2), quantity);
    }
    case FC.READ_HOLDING_REGISTERS:
    case FC.READ_INPUT_REGISTERS: {
      const byteCount = pdu[1];
      if (byteCount !== quantity * 2 || pdu.length < 2 + byteCount) throw new Error('Bad register byte count');
      const out = new Array(quantity);
      for (let i = 0; i < quantity; i++) out[i] = pdu.readUInt16BE(2 + i * 2);
      return out;
    }
    case FC.WRITE_MULTIPLE_COILS:
    case FC.WRITE_MULTIPLE_REGISTERS:
      if (pdu.length < 5 || pdu.readUInt16BE(1) !== request.readUInt16BE(1) || pdu.readUInt16BE(3) !== quantity) {
        throw new Error('Write echo mismatch');
      }
      return true;
    default:
      throw new Error(`Unsupported function code ${fc}`);
  }
}

module.exports = {
  FC,
  LIMITS,
  EXCEPTION_TEXT,
  ModbusException,
  FrameReader,
  encodeAdu,
  packBits,
  unpackBits,
  readRequest,
  writeCoilsRequest,
  writeRegistersRequest,
  parseResponse,
};
