#!/usr/bin/env node
/**
 * Weighbridge Scale Indicator — Serial Diagnostic Harness
 * ---------------------------------------------------------
 * Standalone Node.js tool (no Electron, no UI) for confirming what a
 * physical scale indicator actually sends over RS232 before any parser
 * or app code is written against it.
 *
 * Run `node serial-harness.js --help` for usage.
 */

const { SerialPort } = require('serialport');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------- Known-indicator starting points ----------
// These are best-guess defaults pulled from public manuals. They are a
// starting point, NOT a guarantee — always confirm against the real unit's
// own settings menu, and use --sweep if nothing comes through.
const PRESETS = {
  a12: {
    baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1,
    note: 'Yaohua XK3190-A12 — manual specifies even parity. Baud is device-selectable ' +
          '(P2 menu: 1=9600 2=4800 3=2400 4=1200) — confirm on the indicator itself. ' +
          'Continuous-mode frames look like: WG000.000kg + 2-byte checksum + CRLF.',
  },
  a15: {
    baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1,
    note: 'Yaohua XK3190-A15 — same family/frame format as A12, same starting point.',
  },
  xk315: {
    baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
    note: 'XK315 / XK315A1 series — NOT the same indicator as A15, despite the similar name. ' +
          'Confirmed from public specs: continuous ASCII output, baud selectable among ' +
          '1200/2400/4800/9600 on the unit itself. Exact frame format (checksum vs plain ' +
          'ASCII, parity) is NOT confirmed for this model — if this preset shows garbled ' +
          'output, try --parity even, and if still garbled run --sweep to find the real baud.',
  },
  lp75: {
    baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
    note: 'Locosc/Loadmaster LP7510/7515/7516 — check indicator setting C19 for actual ' +
          'baud rate. Frames look like readable ASCII: "ST,GS+5.12KG" + CRLF, no checksum.',
  },
  defender3000: {
    baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
    note: 'Ohaus Defender 3000 (T31P/T32XW) — usually command-response, not continuous. ' +
          'Once connected, try typing:  IP   or   P   then Enter, to request a reading.',
  },
  generic: {
    baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
    note: 'No known profile for this indicator (e.g. SKR). Run with --sweep first to find ' +
          'a baud rate that produces readable data, then reconnect using that baud rate.',
  },
};

const COMMON_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400];

// ---------- CLI args ----------
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { list: false, sweep: false, preset: 'generic' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list') opts.list = true;
    else if (a === '--sweep') opts.sweep = true;
    else if (a === '--port') opts.port = args[++i];
    else if (a === '--baud') opts.baudRate = parseInt(args[++i], 10);
    else if (a === '--databits') opts.dataBits = parseInt(args[++i], 10);
    else if (a === '--parity') opts.parity = args[++i];
    else if (a === '--stopbits') opts.stopBits = parseInt(args[++i], 10);
    else if (a === '--preset') opts.preset = args[++i];
    else if (a === '--lineending') opts.lineEnding = args[++i]; // cr | lf | crlf
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Weighbridge Serial Diagnostic Harness
--------------------------------------
Usage:
  node serial-harness.js --list
      List all available serial ports on this PC.

  node serial-harness.js --port COM3 --preset a12
      Connect using a known preset (a12, a15, xk315, lp75, defender3000, generic).

  node serial-harness.js --port COM3 --baud 9600 --databits 8 --parity none --stopbits 1
      Connect with fully manual settings (overrides any preset given).

  node serial-harness.js --port COM3 --preset generic --sweep
      Try every common baud rate for a few seconds each and report which
      one(s) produced readable-looking data. Use this for undocumented
      indicators (e.g. SKR) where we have no manual to start from.

Once connected:
  - Incoming bytes are shown live as HEX + ASCII, and logged to ./captures/
  - Recognisable CR/LF-terminated frames are also shown on their own line
  - Type text and press Enter to send a command to the indicator (e.g. R, P, IP)
  - Type :baud 4800  to change baud rate live without restarting
  - Type :quit        to exit
`);
}

// ---------- Formatting helpers ----------
function hexAndAscii(buffer) {
  const hex = [...buffer].map(b => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...buffer].map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
  return { hex, ascii };
}

function timestamp() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function printableRatio(buffer) {
  if (buffer.length === 0) return 0;
  let printable = 0;
  for (const b of buffer) {
    if ((b >= 32 && b <= 126) || b === 13 || b === 10) printable++;
  }
  return printable / buffer.length;
}

// ---------- Logging ----------
function makeLogger(portName) {
  const dir = path.join(__dirname, 'captures');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const safeName = portName.replace(/[^a-z0-9]/gi, '_');
  const file = path.join(dir, `${safeName}-${Date.now()}.log`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  console.log(`Logging raw capture to: ${file}\n`);
  return {
    write(line) { stream.write(line + '\n'); },
    file,
  };
}

// ---------- Main connect + live view ----------
function openAndWatch(portPath, settings, opts) {
  const port = new SerialPort({
    path: portPath,
    baudRate: settings.baudRate,
    dataBits: settings.dataBits || 8,
    parity: settings.parity || 'none',
    stopBits: settings.stopBits || 1,
    autoOpen: false,
  });

  const logger = makeLogger(portPath);
  let lineBuffer = Buffer.alloc(0);
  let framesSeen = 0;

  port.open((err) => {
    if (err) {
      console.error(`Failed to open ${portPath}: ${err.message}`);
      process.exit(1);
    }
    console.log(`Connected to ${portPath} @ ${settings.baudRate} baud, ${settings.dataBits || 8}${(settings.parity || 'none')[0].toUpperCase()}${settings.stopBits || 1}`);
    if (settings.note) console.log(`Note: ${settings.note}`);
    console.log('Waiting for data... (type a command + Enter to send one, or :quit to exit)\n');

    setTimeout(() => {
      if (framesSeen === 0) {
        console.log('--- No data received yet. ---');
        console.log('If this indicator is command-response (not continuous), try typing: R  or  P  or  IP  then Enter.');
        console.log('If still nothing, double check TX/RX wiring is not swapped, and try --sweep to test other baud rates.\n');
      }
    }, 4000);

    port.on('data', (chunk) => {
      framesSeen++;
      const { hex, ascii } = hexAndAscii(chunk);
      const line = `[${timestamp()}] RX ${chunk.length}B  HEX: ${hex}   ASCII: ${ascii}`;
      console.log(line);
      logger.write(line);

      lineBuffer = Buffer.concat([lineBuffer, chunk]);
      let idx;
      while ((idx = lineBuffer.indexOf(0x0a)) !== -1 || (idx = lineBuffer.indexOf(0x0d)) !== -1) {
        const frame = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        if (frame.length > 0) {
          const framed = `           FRAME: "${frame.toString('ascii').trim()}"`;
          console.log(framed);
          logger.write(framed);
        }
      }
    });

    port.on('error', (e) => console.error(`Port error: ${e.message}`));
  });

  // interactive stdin -> port (for command-response indicators, and manual testing)
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (input) => {
    if (input === ':quit') {
      port.close(() => process.exit(0));
      return;
    }
    if (input.startsWith(':baud ')) {
      const newBaud = parseInt(input.split(' ')[1], 10);
      port.update({ baudRate: newBaud }, (err) => {
        if (err) console.error(`Could not change baud: ${err.message}`);
        else console.log(`Baud rate changed to ${newBaud}`);
      });
      return;
    }
    const ending = { cr: '\r', lf: '\n', crlf: '\r\n' }[opts.lineEnding || 'cr'];
    port.write(input + ending, (err) => {
      if (err) console.error(`Write failed: ${err.message}`);
      else {
        const sentLine = `[${timestamp()}] TX "${input}"`;
        console.log(sentLine);
        logger.write(sentLine);
      }
    });
  });
}

// ---------- Baud sweep mode (for undocumented indicators like SKR) ----------
async function sweep(portPath) {
  console.log(`Sweeping common baud rates on ${portPath}. Make sure the indicator is powered on and connected, and there is a weight change or key-press happening on it during the test if it's command-response.\n`);
  for (const baud of COMMON_BAUD_RATES) {
    console.log(`--- Trying ${baud} baud (8N1) for 3 seconds ---`);
    const result = await trySample(portPath, { baudRate: baud, dataBits: 8, parity: 'none', stopBits: 1 }, 3000);
    console.log(result.summary);
    if (result.printableRatio > 0.8 && result.bytes > 0) {
      console.log(`  -> Looks promising (${(result.printableRatio * 100).toFixed(0)}% printable). Try connecting with: --baud ${baud} --parity none\n`);
    } else {
      console.log('');
    }
  }
  console.log('Sweep complete. If nothing looked readable, try again — some indicators need --parity even, or only send data when a key is pressed on the unit.');
}

function trySample(portPath, settings, durationMs) {
  return new Promise((resolve) => {
    const port = new SerialPort({ path: portPath, ...settings, autoOpen: false });
    let collected = Buffer.alloc(0);
    port.open((err) => {
      if (err) {
        resolve({ summary: `  Could not open port: ${err.message}`, bytes: 0, printableRatio: 0 });
        return;
      }
      port.on('data', (chunk) => { collected = Buffer.concat([collected, chunk]); });
      setTimeout(() => {
        port.close(() => {
          const ratio = printableRatio(collected);
          const { ascii } = hexAndAscii(collected.slice(0, 60));
          const summary = collected.length > 0
            ? `  Received ${collected.length} bytes. Sample: "${ascii}"`
            : `  No data received.`;
          resolve({ summary, bytes: collected.length, printableRatio: ratio });
        });
      }, durationMs);
    });
    port.on('error', () => {
      resolve({ summary: '  Port error while sampling.', bytes: 0, printableRatio: 0 });
    });
  });
}

// ---------- Entry point ----------
async function main() {
  const opts = parseArgs();
  if (opts.help) { printHelp(); return; }

  if (opts.list) {
    const ports = await SerialPort.list();
    if (ports.length === 0) {
      console.log('No serial ports found. If using a USB-to-RS232 adapter, check it is plugged in and drivers are installed (Device Manager on Windows).');
      return;
    }
    console.log('Available serial ports:\n');
    ports.forEach(p => {
      console.log(`  ${p.path}  ${p.manufacturer ? '(' + p.manufacturer + ')' : ''}`);
    });
    return;
  }

  if (!opts.port) {
    console.log('Missing --port. Run with --list to see available ports, or --help for usage.');
    return;
  }

  if (opts.sweep) {
    await sweep(opts.port);
    return;
  }

  const preset = PRESETS[opts.preset] || PRESETS.generic;
  const settings = {
    baudRate: opts.baudRate || preset.baudRate,
    dataBits: opts.dataBits || preset.dataBits,
    parity: opts.parity || preset.parity,
    stopBits: opts.stopBits || preset.stopBits,
    note: preset.note,
  };

  openAndWatch(opts.port, settings, opts);
}

main();