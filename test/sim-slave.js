'use strict';

// Simulated field devices for bench testing without hardware.
// Usage: node test/sim-slave.js [port ...]   (default 5021 5022)
// Each device counts holding register 0 up every second and mirrors coil 0 into coil 1.

const { DataStore } = require('../src/datastore');
const { ModbusSlave } = require('../src/slave');

function startSimulator(port) {
  const store = new DataStore();
  for (let i = 0; i < 100; i++) store.holdings[i] = (port % 1000) * 10 + i;
  const slave = new ModbusSlave(store, { port, host: '127.0.0.1' });
  return slave.start().then((ok) => {
    if (!ok) throw new Error(`Simulator could not listen on ${port}`);
    return { store, slave };
  });
}

module.exports = { startSimulator };

if (require.main === module) {
  const ports = process.argv.slice(2).map(Number).filter(Boolean);
  for (const port of ports.length ? ports : [5021, 5022]) {
    startSimulator(port).then(({ store }) => {
      console.log(`Simulated device on 127.0.0.1:${port}`);
      setInterval(() => {
        store.holdings[0] = (store.holdings[0] + 1) & 0xffff;
        store.coils[1] = store.coils[0];
      }, 1000);
    });
  }
}
