# Weighbridge Serial Diagnostic Harness

Purpose: confirm what each physical indicator actually sends over RS232
*before* any parser or Electron code is written against it. This is a
standalone Node.js tool — no Electron, no database, no UI. Just the wire.

---

## 1. One-time setup (each person, on their own PC)

1. Install Node.js LTS from https://nodejs.org if not already installed.
2. Copy this `serial-harness` folder to your machine.
3. Open a terminal in the folder and run:
   ```
   npm install
   ```
4. Connect the indicator to your PC (via RS232 port, or USB-to-RS232 adapter
   if your laptop has no serial port).
5. Find your port name:
   ```
   node serial-harness.js --list
   ```
   - Windows: looks like `COM3`, `COM4`, etc.
   - If nothing shows up: check Device Manager → Ports (COM & LPT). If the
     adapter shows with a yellow warning icon, install its driver first
     (search the adapter's chipset name, e.g. "CH340 driver", "FTDI driver").

---

## 2. Per-indicator instructions

Run one of these depending on which unit is in front of you. Everyone can
do this in parallel — grab whichever indicator(s) you have physical access
to, we don't need to do this in sequence.

### A12 (Yaohua XK3190-A12)
```
node serial-harness.js --port COM3 --preset a12
```
Load/unload weight on the scale and watch for continuous `FRAME:` lines
like `WG012.340kg`. If nothing appears, check the indicator's own **P2**
setting menu for its actual baud rate and re-run with `--baud <value>`.

### A15 (Yaohua XK3190-A15)
```
node serial-harness.js --port COM3 --preset a15
```
Same expected behaviour as A12 — same manufacturer family.

### LP75 (Locosc/Loadmaster LP7510 / LP7515 / LP7516)
```
node serial-harness.js --port COM3 --preset lp75
```
Expect readable frames like `ST,GS+5.12KG`. If nothing shows, check the
indicator's **C19** setting for its configured baud rate.

### Defender 3000 (Ohaus T31P / T32XW)
```
node serial-harness.js --port COM3 --preset defender3000
```
This one likely won't stream on its own. Once connected, **type `IP` and
press Enter** (or `P`) to request a reading — watch for a `TX` line
confirming it was sent, followed by an `RX`/`FRAME` reply.

### SKR (no manual available — unknown protocol)
```
node serial-harness.js --port COM3 --preset generic --sweep
```
This tries every common baud rate for a few seconds each and tells you
which one(s) produced readable-looking data. Once you see a promising
result, reconnect using that baud rate to confirm:
```
node serial-harness.js --port COM3 --baud <value_from_sweep>
```
If the sweep finds nothing at all, try pressing keys on the indicator
(zero, tare, print) *while* the sweep is running — some units are
command-response only and won't transmit unless prompted.

---

## 3. What "success" looks like

You're done testing an indicator once you can see, live in the terminal:

- Weight changing on the physical scale → visibly reflected in the
  `FRAME:` output within a second or two, **or**
- Typing a request command → a reply frame containing a weight value

Every session automatically writes a full log to `./captures/`. Please
don't delete these — rename the file with the indicator name if it isn't
obvious, e.g. `A12-loadingdock.log`.

---

## 4. What to bring back

For each indicator you test, share:
1. The exact command you ran (port, baud, preset/manual settings)
2. A short excerpt of the captured `FRAME:` lines (5–10 lines is enough)
3. Anything that didn't match the preset's expected format
4. The `.log` file itself from `./captures/`

Paste these back and I'll write the actual protocol parser for each
indicator family, matched to what your hardware *actually* sends — not
just what the manual claims. Once we have that confirmed for all five,
this becomes the foundation for the real hardware module (Jonah's side)
and the scale simulator (so Daisi and Augustine can build UI/sync against
realistic fake data without needing the hardware on their own desks).

---

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Port opens but zero bytes ever received | TX/RX wired backwards — needs a null-modem (crossed) cable, not straight-through |
| Garbled/random characters | Wrong baud rate or parity — try `--sweep`, or try `--parity even` |
| Works but stops after a few seconds | Some indicators only transmit while the weight is actively changing — try nudging the load |
| "Access denied" / port busy | Another program (or another instance of this tool) already has the port open — close it first |
| No ports listed at all | USB-to-RS232 adapter driver not installed — check Device Manager |
