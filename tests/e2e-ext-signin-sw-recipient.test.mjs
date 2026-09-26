#!/usr/bin/env node
/**
 * tests/e2e-ext-signin-sw-recipient.test.mjs — #18 Fix C
 * (T-SW-REGISTER-ON-TYPED-SIGNIN, reproduced on Dennis's prod session).
 *
 * THE SURFACE WAS THE EXTENSION. relay-dennis-room-20260926T0010-0910Z.log:
 * the 08:10 pairings went out `recips2` — a second recipient exists only when
 * the page is FRAMED by the extension and the SW answered with a key. At
 * 08:16:12Z and 08:22:43Z the page closed `page_unload` and, in the same
 * instant, the listener socket closed 1005 (no status): the SW's only
 * status-less ws.close() is its 'signed-out' handler, i.e. an extension
 * sign-out. Sign-in followed ~9 s later, and every pairing after it advertised
 * `recipients=1` — so the extension SW could not open a sealed
 * PHONE_NOTIFICATION for the rest of the session.
 *
 * WHY. The sign-out handler clears the SW key's registration (INC-0923 B-1:
 * the claim is the account's) and the key is withheld from the advert until
 * it is registered again. The sign-in paths — mintTokenFromCookie (typed /
 * embedded / windowed password) and runGoogleSignIn — never registered. The
 * only message that did ('auth-updated') is sent by nothing any more.
 *
 * WHAT IS REAL HERE
 *   - background.js: registerDeviceKeyBestEffort, registerDeviceKeyWithRetry,
 *     registerAfterSignIn, mintTokenFromCookie, bridgeIdentityFields and
 *     nullKeyReason are SLICED from the shipped source and executed with only
 *     their I/O injected (fetch, the token store, the registry POST). An MV3
 *     worker cannot be booted from node; every decision below is the file's own.
 *   - hooks/phoneE2e.ts: readSwKey, buildRequestBlock, filterRecipsToLiveRows,
 *     swBridgeAnswer — the page's side of the advert, fed the bridge reply.
 *   - chrome-extension/e2e/*: the VENDORED crypto the SW runs. A real wrap is
 *     addressed to the SW's deviceId, the SW unwraps it, the phone seals a
 *     PHONE_NOTIFICATION under p2c, and the SW's own inboundDisposition +
 *     openSealedFrame open it.
 *
 * CONTROL. §3 re-runs the sign-in with the pre-fix mintTokenFromCookie (the
 * registerAfterSignIn line removed) and requires the prod shape back:
 * recipients=1 swBridge=none and a SW with no wrap to open.
 *
 * Run: node tests/e2e-ext-signin-sw-recipient.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import {
  buildRequestBlock,
  filterRecipsToLiveRows,
  readSwKey,
  swBridgeAnswer,
} from '../hooks/phoneE2e.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const subtle = webcrypto.subtle;
const K = await import('../chrome-extension/e2e/kdf.mjs');
const S = await import('../chrome-extension/e2e/sw-session.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok  ${name}`); return; }
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

// ── slice the shipped worker functions ──────────────────────────────────────
const BG = read('chrome-extension/background.js');
function sliceFn(src, name) {
  const re = new RegExp(`\\n((?:async )?function ${name}\\()`);
  const m = re.exec(src);
  if (!m) throw new Error(`background.js: function ${name} not found`);
  const start = m.index + 1;
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`background.js: end of ${name} not found`);
  return src.slice(start, end + 2);
}
function sliceLine(src, prefix) {
  const i = src.indexOf(`\n${prefix}`);
  if (i < 0) throw new Error(`background.js: "${prefix}" not found`);
  return src.slice(i + 1, src.indexOf('\n', i + 1) + 1);
}
const FNS = ['nullKeyReason', 'bridgeIdentityFields', 'registerDeviceKeyBestEffort',
  'registerDeviceKeyWithRetry', 'registerAfterSignIn', 'mintTokenFromCookie'];

function bootWorker(src) {
  const code = [
    sliceLine(src, 'const REGISTER_BACKOFF_MS'),
    ...FNS.map((n) => sliceFn(src, n)),
  ].join('\n');
  const io = { token: null, posts: [], broadcasts: 0, connects: 0 };
  const factory = new Function('io', 'fetch', 'self', 'console', `
    let swDeviceId = 'dev-ext-02';
    let swPubKey = io.swPub;
    let swRegistered = false;            // the 'signed-out' handler just cleared it
    let deviceKeyError = null;
    let deviceKeyRegisterError = 'signed-out';
    let signedIn = false;
    let reconnectAttempts = 3;
    let registerInFlight = null;
    const getToken = async () => io.token;
    const storeToken = async (t) => { io.token = t; };
    const registerSwDeviceKey = async ({ token }) => { io.posts.push(token); return { ok: true }; };
    const trace = () => {};
    const broadcastE2eStatus = () => { io.broadcasts += 1; };
    const refreshIndicator = () => {};
    const connect = () => { io.connects += 1; };
    ${code}
    return {
      mintTokenFromCookie, bridgeIdentityFields,
      state: () => ({ swRegistered, signedIn, deviceKeyRegisterError }),
    };`);
  return { io, factory };
}

const b64u = (b) => Buffer.from([4, ...new Array(64).fill(b)]).toString('base64url');
const WEB_KEY = { deviceId: 'web-fixc-01', pubB64Url: b64u(0x22) };

/** Sign in through the shipped path, then pair the way the page does. */
async function signInThenPair(src, swPub) {
  const { io, factory } = bootWorker(src);
  io.swPub = swPub;
  const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({ ext_token: 'ext-jwt' }) });
  const w = factory(io, fetchStub, { CC: { EXT_TOKEN_URL: 'https://computercaller.com/api/auth/ext-token' } }, { warn() {}, log() {} });
  const ok = await w.mintTokenFromCookie();
  await flush();
  // shell.js answers the page's e2e-pubkey-request with bridgeIdentityFields().
  const reply = { source: 'cc-ext', type: 'e2e-pubkey', v: 1, ...w.bridgeIdentityFields(), pairingId: null };
  const sw = readSwKey(reply);
  const block = buildRequestBlock({ localMode: 'on', webKey: WEB_KEY, sw });
  const live = new Set([WEB_KEY.deviceId, 'dev-ext-02']);
  block.recips = filterRecipsToLiveRows(block.recips, live, WEB_KEY.deviceId).recips;
  const answer = swBridgeAnswer(sw, true);
  return { ok, io, state: w.state(), reply, sw, block, line: `[e2e] advert recipients=${block.recips.length} swBridge=${answer}` };
}

// ── 1. the evidence reading, pinned to the source it rests on ───────────────
console.log('1. why the prod surface was the extension (source facts the verdict uses)');
{
  const code = BG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const closes = code.match(/ws\s*&&\s*ws\.close\(\)|ws\.close\(/g) || [];
  eq('background.js has exactly ONE listener ws.close(), status-less (-> relay logs 1005)', closes, ['ws && ws.close()']);
  const so = code.slice(code.indexOf("message?.type === 'signed-out'"), code.indexOf("message?.type === 'signed-out'") + 2500);
  check("...and it sits in the 'signed-out' handler, which also clears the registration",
    /clearDeviceKeyRegistered\(\)/.test(so) && /swRegistered = false;/.test(so) && /ws && ws\.close\(\)/.test(so));
  const shell = read('chrome-extension/shell.js');
  check("'signed-out' is sent only by the extension shell's own signOut()",
    (shell.match(/type: 'signed-out'/g) || []).length === 1 && /async function signOut\(\)[\s\S]{0,1400}type: 'signed-out'/.test(shell));
  const phone = read('hooks/phoneE2e.ts');
  check('a 2nd recipient requires a present SW key, which only a FRAMED page can hear',
    /if \(sw\.status === 'present' && sw\.recipient\) recips\.push\(sw\.recipient\);/.test(phone)
    && /window\.parent === window\) return undefined;/.test(read('hooks/useE2e.ts')));
  check("nothing sends 'auth-updated' any more (the one path that registered on sign-in)",
    !/type: 'auth-updated'/.test(shell) && !/type: 'auth-updated'/.test(BG));
}

// ── 2. the fix: sign-in re-registers, the advert carries the SW key ─────────
console.log('2. sign-in after a sign-out -> registered -> recipients=2 swBridge=key');
const swPriv = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const swPub = S.toBase64Url(new Uint8Array(await subtle.exportKey('raw', swPriv.publicKey)));
const fixed = await signInThenPair(BG, swPub);
check('sign-in minted and stored the token', fixed.ok === true && fixed.io.token === 'ext-jwt');
eq('the sign-in POSTed the SW key to the registry once, with the new token', fixed.io.posts, ['ext-jwt']);
check('the worker is registered again and broadcast it (shell pushes the key on that edge)',
  fixed.state.swRegistered === true && fixed.io.broadcasts >= 1 && fixed.state.deviceKeyRegisterError === null);
check('the bridge reply carries the key', fixed.reply.deviceId === 'dev-ext-02' && fixed.reply.pub === swPub && fixed.reply.reason === null);
eq('the page reads it as present', fixed.sw.status, 'present');
eq('the advert: [e2e] advert recipients=2 swBridge=key', fixed.line, '[e2e] advert recipients=2 swBridge=key');
eq('the recipients are the web key and the extension key', fixed.block.recips.map((r) => r.kind), ['web', 'extension']);
check('useE2e logs the advert with exactly this template',
  read('hooks/useE2e.ts').includes('`[e2e] advert recipients=${advertisedRecipients} swBridge=${answer}`'));
check('both sign-in paths call registerAfterSignIn before connect()',
  /await storeToken\(body\.ext_token\);[\s\S]{0,120}registerAfterSignIn\('sign-in-cookie'\);\s*connect\(\);/.test(BG)
  && /await storeToken\(token\);[\s\S]{0,120}registerAfterSignIn\('sign-in-google'\);\s*connect\(\);/.test(BG));

// ── 3. control: the pre-fix sign-in reproduces prod ─────────────────────────
console.log('3. CONTROL: pre-fix sign-in');
const PRE = BG.replace("    registerAfterSignIn('sign-in-cookie');\n", '');
check('control source actually differs from the shipped one', PRE !== BG);
const pre = await signInThenPair(PRE, swPub);
eq('CONTROL: no registry POST on sign-in', pre.io.posts, []);
eq('CONTROL: bridge withholds the key (not-registered)', [pre.reply.pub, pre.reply.reason], [null, 'not-registered']);
eq('CONTROL: the prod advert reproduces', pre.line, '[e2e] advert recipients=1 swBridge=none');

// ── 4. a sealed PHONE_NOTIFICATION opens in the extension SW ────────────────
console.log('4. sealed PHONE_NOTIFICATION -> the SW opens it (vendored crypto)');
const V = JSON.parse(read('tests/kdf-vectors.json'));
const J = V.canonicalPeer;
const ctxWire = J.positiveJ1.ctxWire; // peerDeviceId dev-ext-02 = this SW
const inputs = K.pairContextFromWire(ctxWire, { userId: J.localUserId });
const sk = webcrypto.getRandomValues(new Uint8Array(32));
const KID = 'kid-fix-c';
// The phone wraps SK to the SW's advertised static key (§13.2), as it does for
// every recipient in the advert — which is why the advert had to carry it.
const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const swPubRaw = new Uint8Array(Buffer.from(fixed.block.recips[1].pub, 'base64url'));
const swPubKey = await subtle.importKey('raw', swPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
const z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: swPubKey }, eph.privateKey, 256));
const kekBytes = await K.kek({ pairingId: inputs.pairingId, sharedSecret: z, context: inputs.contextBytes, recipientKey: swPubRaw }, subtle);
const kekKey = await subtle.importKey('raw', kekBytes, 'AES-GCM', false, ['encrypt']);
const wrap = await K.seal({
  sender: { direction: K.DIR_P2C, key: kekKey, sessionPrefix: await S.wrapPrefix('dev-ext-02', subtle) },
  frameType: S.WRAP_FRAME_TYPE, kid: KID, seq: 0, pairEpoch: inputs.pairEpoch, plaintext: sk,
}, subtle);
const block = { kid: KID, mode: 1, ctx: ctxWire, epk: S.toBase64Url(new Uint8Array(await subtle.exportKey('raw', eph.publicKey))), wrap: S.toBase64Url(wrap) };
const ctxInputs = { ...inputs, userId: J.localUserId };
const opened = await S.unwrapSessionKey({ block, privateKey: swPriv.privateKey, ownPub: swPub, ownDeviceId: 'dev-ext-02', ctxInputs }, subtle);
eq('the SW unwraps the session key addressed to the key it advertised', K.toHex(opened), K.toHex(sk));
const session = await S.buildSession({ pairingId: inputs.pairingId, sessionKey: opened, ctxInputs }, subtle);
const phone = await K.trafficKeys({ pairingId: inputs.pairingId, sessionKey: sk, context: inputs.contextBytes, role: 'phone' }, subtle);
const notif = { notificationKey: '0|com.bank|9', packageName: 'com.bank', appName: 'Bank', title: 'Card used', body: 'EUR 12.00' };
const c = await K.seal({ sender: phone.send, frameType: 'PHONE_NOTIFICATION', kid: KID, seq: 0, pairEpoch: inputs.pairEpoch,
  plaintext: new TextEncoder().encode(JSON.stringify(notif)) }, subtle);
const envelope = { e: 1, kid: KID, s: 0, c: S.toBase64Url(c) };
check('the wire body is a sealed envelope without the title', S.isSealedEnvelope(envelope) && !JSON.stringify(envelope).includes('Card used'));
eq("the SW's inbound disposition for it (mode open) is UNSEAL",
  S.inboundDisposition({ mode: 'open', frameType: 'PHONE_NOTIFICATION', data: envelope }), S.INBOUND_UNSEAL);
const out = await S.openSealedFrame({ session, frameType: 'PHONE_NOTIFICATION', envelope, pairEpoch: inputs.pairEpoch }, subtle);
eq('the SW opens the sealed PHONE_NOTIFICATION', [out.title, out.body, out.notificationKey], [notif.title, notif.body, notif.notificationKey]);
{
  // Without the SW key in the advert the phone wraps to the web key only; the
  // SW then has nothing addressed to it. A wrap for ANOTHER key does not open.
  const other = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  let threw = false;
  try {
    await S.unwrapSessionKey({ block, privateKey: other.privateKey, ownPub: S.toBase64Url(new Uint8Array(await subtle.exportKey('raw', other.publicKey))), ownDeviceId: 'dev-ext-02', ctxInputs }, subtle);
  } catch { threw = true; }
  check('CONTROL: a SW key that was not the advertised recipient cannot open the wrap', threw);
}
{
  const before = failed;
  check('self-test (DELIBERATE - the FAIL line above is this one): a false assertion is recorded', false);
  const detected = failed === before + 1;
  failed = before;
  check('self-test: ...and the counter was restored', detected);
}

const total = passed + failed;
console.log(`e2e-ext-signin-sw-recipient: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
