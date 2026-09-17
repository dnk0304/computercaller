// Relay tests — explicit `maxPayload` on the WebSocketServer (FORGE-V, 2026-09-17).
//
// Run: node tests/ws-maxpayload.test.mjs      (no DB, no Next.js boot)
//
// WHY THIS EXISTS
// ---------------
// server.js built its relay as `new WebSocketServer({ noServer: true })` with no
// `maxPayload`, so the only cap was ws@8.21's 100 MiB default. Any peer past the
// auth gate could push 100 MiB frames that the relay materialises via
// `data.toString()` and runs through frame redaction/logging BEFORE any tier or
// role gate sees them — a free memory + CPU amplifier per authenticated socket.
//
// PART 1 proves the RUNTIME semantics we are relying on, against a real ws
// server configured with the real constant: a frame at cap-1 is delivered
// intact, a frame at cap+1 closes the sender with 1009, and the peer socket on
// the same server is untouched. server.js cannot be imported without booting
// Next.js (the established constraint in every sibling .mjs relay test), so
// PART 2 asserts against the real server.js SOURCE that the relay's own
// WebSocketServer is constructed with that same constant and that both close
// paths log the over-cap line. Part 1 alone could pass while server.js still
// shipped the 100 MiB default; Part 2 alone could pass while ws behaved
// differently. Both together are the proof.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else {
    fail += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`);
  }
}

// ── The constant, read out of server.js rather than restated ────────────────
// A hard-coded 1048576 here would keep passing if someone lowered the server's
// cap, so the test's cap IS the server's cap.
const CONST_RE = /const RELAY_MAX_PAYLOAD_BYTES = ([^;]+);/;
const constMatch = SERVER_SRC.match(CONST_RE);
check('server.js declares RELAY_MAX_PAYLOAD_BYTES', !!constMatch);
if (!constMatch) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
// Arithmetic literal only (e.g. `1024 * 1024`) — never anything callable.
const expr = constMatch[1].trim();
check('constant is a plain arithmetic literal', /^[\d_ *+]+$/.test(expr), expr);
const CAP = Number(new Function(`return (${expr})`)());
check('cap is 1 MiB', CAP === 1024 * 1024, CAP);

// The measurement this cap is derived from: the largest legitimate frame is
// the 64 KiB base64 slice of MMS_MEDIA_CHUNK. If the Android sender ever grows
// that slice past the cap, this test fails instead of production failing.
const PHONE_SERVICE = path.join(
  ROOT, 'dnkdialer-android/app/src/main/java/com/dnkdialer/companion/PhoneService.kt');
if (fs.existsSync(PHONE_SERVICE)) {
  const kt = fs.readFileSync(PHONE_SERVICE, 'utf8');
  const m = kt.match(/val chunkSize = (\d+)/);
  check('Android MMS chunkSize still found', !!m);
  if (m) {
    const chunkSize = Number(m[1]);
    // base64 slice + JSON envelope; 8 KiB is a fat allowance for the envelope.
    check('largest legitimate frame fits well under the cap',
      chunkSize + 8192 < CAP / 2, { chunkSize, CAP });
  }
} else {
  console.log('  skip Android sender not present in this checkout');
}

// ── PART 1 — runtime: cap-1 delivered, cap+1 closed 1009, peer survives ─────

console.log('\nPART 1 — runtime behaviour of maxPayload');

/** Frame of exactly `n` bytes (ASCII, so bytes === chars). */
const frameOf = (n) => 'x'.repeat(n);

async function runtimeChecks() {
  // Ephemeral port (0) — a fixed port collides with the other harnesses that
  // run on this box.
  const wss = new WebSocketServer({ port: 0, maxPayload: CAP });
  await new Promise((r) => wss.once('listening', r));
  const url = `ws://127.0.0.1:${wss.address().port}`;

  const received = [];
  // The SERVER side is the receiver that raises the RangeError — it is the
  // side server.js is, so whatever it observes here is what the relay can key
  // its log line off. Both signals are recorded and awaited: a snapshot taken
  // when the CLIENT closes races the server's own teardown.
  let resolveServerClose;
  const serverClose = new Promise((r) => { resolveServerClose = r; });
  const serverCloses = [];
  const serverErrors = [];
  wss.on('connection', (ws) => {
    ws.on('message', (data) => received.push(Buffer.byteLength(data)));
    ws.on('error', (err) => serverErrors.push(err));
    ws.on('close', (code) => { serverCloses.push(code); resolveServerClose(code); });
  });

  const open = (label) => new Promise((resolve, reject) => {
    const c = new WebSocket(url);
    c.label = label;
    c.closeCode = null;
    c.on('close', (code) => { c.closeCode = code; });
    c.on('error', () => {});
    c.once('open', () => resolve(c));
    c.once('error', reject);
  });

  const peer = await open('peer');     // stays quiet the whole time
  const sender = await open('sender');

  // 1. cap-1 is delivered intact.
  const under = CAP - 1;
  sender.send(frameOf(under));
  await new Promise((r) => setTimeout(r, 250));
  check('frame at cap-1 is delivered', received.includes(under), { received, under });
  check('sender still open after cap-1 frame', sender.readyState === WebSocket.OPEN);

  // 2. cap+1 closes the sender with 1009 and is never delivered.
  const over = CAP + 1;
  const senderClosed = new Promise((r) => sender.once('close', r));
  sender.send(frameOf(over));
  const closeCode = await Promise.race([
    senderClosed,
    new Promise((r) => setTimeout(() => r('timeout'), 3000)),
  ]);
  check('frame at cap+1 closes the sender with 1009', closeCode === 1009, closeCode);
  check('over-cap frame is never delivered to application code',
    !received.includes(over), received);
  const serverCloseCode = await Promise.race([
    serverClose,
    new Promise((r) => setTimeout(() => r('timeout'), 3000)),
  ]);
  // ws@8.21: the receiver raises a RangeError, SENDS a 1009 close frame and
  // tears the socket down without waiting for the echo. So the offender sees
  // 1009 (asserted above) but our own close event is 1006 — which is why
  // server.js keys its log line off the 'error' event and NOT on closeCode
  // 1009. This assertion pins that asymmetry: if a future ws makes the
  // receiver's own close 1009, this fails and the server can be simplified.
  check('receiver-side close is 1006, not 1009 (no close frame echoed back)',
    serverCloseCode === 1006, { serverCloseCode, serverCloses });
  check('receiver raised WS_ERR_UNSUPPORTED_MESSAGE_LENGTH — the usable signal',
    serverErrors.some((e) => e && e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'),
    serverErrors.map((e) => e && e.code));

  // 3. The peer on the same server is untouched.
  check('peer stays connected', peer.readyState === WebSocket.OPEN,
    { readyState: peer.readyState, closeCode: peer.closeCode });
  peer.send(frameOf(1024));
  await new Promise((r) => setTimeout(r, 250));
  check('peer can still send after the sender was killed', received.includes(1024), received);

  peer.close();
  await new Promise((r) => wss.close(r));
}

// ── PART 2 — source: the RELAY server actually carries the cap ──────────────

function sourceChecks() {
  console.log('\nPART 2 — server.js relay construction');

  // The relay's own WebSocketServer — noServer mode — must carry maxPayload.
  const ctor = SERVER_SRC.match(/new WebSocketServer\(\{[^}]*\}\)/g) || [];
  check('exactly one WebSocketServer is constructed in server.js', ctor.length === 1, ctor);
  const relayCtor = ctor[0] || '';
  check('relay WebSocketServer is still noServer', /noServer:\s*true/.test(relayCtor), relayCtor);
  check('relay WebSocketServer passes maxPayload: RELAY_MAX_PAYLOAD_BYTES',
    /maxPayload:\s*RELAY_MAX_PAYLOAD_BYTES/.test(relayCtor), relayCtor);

  // Both peer paths log the over-cap line from their existing close handler.
  // Strip comments first: a grep-proof that matches the prose describing the
  // invariant instead of the code implementing it proves nothing.
  const code = SERVER_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const calls = (code.match(/(?<!function\s)logIfOverMaxPayload\(ws, token\);/g) || []).length;
  check('logIfOverMaxPayload is called on both close paths (phone + browser)',
    calls === 2, calls);
  check('the log line is gated on the over-cap flag, not on closeCode 1009',
    /function logIfOverMaxPayload\s*\([^)]*\)\s*\{\s*if \(!ws\.overMaxPayload\) return;/.test(code));
  check('the over-cap flag is set from the receiver RangeError code',
    /err\.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'\) ws\.overMaxPayload = true;/.test(code));
  // Scoped to the connection handler: `parseConnection(req)` also appears at
  // the helper's own definition earlier in the file, so a whole-file indexOf
  // compares against the wrong occurrence.
  const handler = code.slice(code.indexOf("wss.on('connection'"));
  const flagAt = handler.indexOf('ws.overMaxPayload = true');
  const parseAt = handler.indexOf('parseConnection(req)');
  check('the flag listener is attached before the auth gate awaits',
    flagAt !== -1 && parseAt !== -1 && flagAt < parseAt, { flagAt, parseAt });
  check('the log line carries role + redacted room and no payload bytes',
    /frame over maxPayload from role=\$\{ws\.role \|\| 'unknown'\} room=\$\{redactToken\(token\)\}/
      .test(code));
}

await runtimeChecks();
sourceChecks();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
