# Modbus TCP Gateway

One **local Modbus TCP slave** (for your SCADA/HMI/BMS) fed by **N Modbus TCP masters**, one per
client device. Each master scans its device every poll cycle and copies data between the device
and the local slave's memory. No dependencies — Node.js 18+ only.

```
SCADA / HMI  ──►  local slave :502  ◄──►  [ shared coils + holding registers ]
                                              ▲            ▲            ▲
                                         master 1     master 2 …   master N
                                              │            │            │
                                        192.168.1.10  192.168.1.11  …  (client devices)
```

## Run

```bash
npm start                          # uses ./config.json (created with defaults on first run)
node src/index.js --config D:/gw/config.json
```

Open `http://<gateway-ip>:8080`. The default page shows live status: the local slave, which
SCADA clients are connected to it, and every configured client device with per-line status,
OK/error counters, response time, the first 16 values and the last error. A data viewer at the
bottom shows the local slave's coils/holdings.

Click **Configuration** and enter the password **`hotelo`** to edit.

## Configuration

Per client (master):

| Field | Meaning |
|---|---|
| Client IP address / Port | The device to poll (port usually 502) |
| Poll interval | Time between scan cycles (ms) |
| Timeout | Per-request response timeout (ms) |
| Write mode | `On change` sends write lines only when local values change (and after every reconnect); `Every cycle` always sends |

Per line:

| Field | Meaning |
|---|---|
| Modbus ID | Unit ID on the client device |
| Transaction type | Read coils (FC1), Write coils (FC15), Read holdings (FC3), Write holdings (FC16) |
| Start address on client | First address on the device |
| Target address on local slave | First address in the gateway's own slave memory |
| Number of coils / holdings | Count; large counts are split into multiple requests automatically |

*Read* lines copy device → local slave. *Write* lines copy local slave → device (so SCADA writes
into the local slave and the gateway forwards it). Addresses are 0-based protocol addresses
(holding register 40001 = address 0). The editor warns when two read lines target overlapping
local addresses.

### Data manipulation on the local slave

Manipulation lines copy bits around inside the local slave's own memory:

| Type | Source | Target |
|---|---|---|
| Copy coils → holding bits | start coil, number of coils | holding address + start bit |
| Copy holding bits → coils | holding address + start bit, number of bits | start coil |
| Copy holding bits → holding bits | holding address + start bit, number of bits | holding address + start bit |

Bit 0 is the least significant bit. A bit range that passes bit 15 carries on into bit 0 of the
next register (e.g. 6 bits from H100 bit 13 = H100.13–H101.2). Only the target bits change;
the other bits in the target registers are left alone. The editor shows each line's resulting
mapping, such as `C0–C7 → H300.4–H300.11`.

Lines run top to bottom, so a later line can use an earlier line's output. They run on a timer
(default every 100 ms) and also straight after any SCADA write to the local slave and after any
master read. Write lines then send the changed values to the client devices on their next cycle.

The local slave answers FC1/2/3/4/5/6/15/16 (FC2 and FC4 read the coil and holding tables).
Its unit ID setting `0` means "answer any unit ID".

Saving applies immediately: masters reconnect with the new config; data already in the local
slave is kept. Changing the web port needs a service restart. The password lives in
`config.json` (`uiPassword`) and is deliberately not editable from the UI.

## Test

```bash
npm test          # end-to-end: two simulated devices, reads, writes, chunking, offline client
npm run sim       # simulated devices on 127.0.0.1:5021 and :5022 for bench testing
```
