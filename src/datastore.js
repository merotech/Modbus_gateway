'use strict';

// The local slave's memory: one coil table and one holding register table, each
// covering the full 0..65535 address space. FC2/FC4 on the slave read the same tables.
class DataStore {
  constructor() {
    this.coils = new Uint8Array(65536);
    this.holdings = new Uint16Array(65536);
    this.onWrite = null;
  }

  // Called after a SCADA write or a master read lands, so manipulation rules see fresh
  // data without waiting for their timer.
  touched() {
    if (this.onWrite) this.onWrite();
  }

  read(area, start, count) {
    const table = area === 'coils' ? this.coils : this.holdings;
    return Array.from(table.subarray(start, start + count));
  }
}

module.exports = { DataStore };
