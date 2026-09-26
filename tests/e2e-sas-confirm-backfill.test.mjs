#!/usr/bin/env node
/**
 * tests/e2e-sas-confirm-backfill.test.mjs — #18 Fix A (NOTIF-DIAG 3, 2026-09-26).
 *
 * THE PROD DEFECT. Every Encrypted-mode pair opened with an EMPTY Alerts list.
 * A vc69 phone replays its notification shade on PAIRING_ACTIVE
 * (PhoneService.kt backfillNotifications) — before either side has confirmed
 * the short code — and E2eFrameGate.outbound drops every sealed frame while the
 * code is pending on the phone. PHONE_NOTIFICATION is sealed; nothing asked
 * again. The web half of the fix re-asks (GET_NOTIFICATIONS + GET_SYNC_ESTIMATE)
 * exactly once when the code is confirmed for the current pair.
 *
 * WHAT IS REAL HERE
 *   - lib/sasConfirmBackfill.ts: the decision usePhoneBridge's effect calls.
 *   - lib/notificationMerge.ts: the REAL Alerts merge (applyNotifEvents) and
 *     the REAL unread rule (isUnreadAlert) — the dedupe a vc70 phone's second
 *     shade has to survive.
 *   - lib/e2e/kdf.mjs: REAL AES-GCM. The phone seals every PHONE_NOTIFICATION
 *     under the p2c traffic key and the page opens it under its own; the wire
 *     body is asserted to be an envelope that does not contain the title.
 * WHAT IS MODELLED (and says so): the phone. Its gate is the two rules
 *   E2eFrameGate.kt holds — outbound drops SEALED types while the code is
 *   pending; inbound passes a request that is not sealed — and each rule's
 *   source is pinned below so the model cannot drift from the file.
 *
 * CONTROLS. §4 runs the vc69 scenario WITHOUT the re-send (the pre-fix page)
 * and requires the Alerts list to come out EMPTY — the prod symptom — so a
 * green §3 is evidence about the fix, not about the harness. §4 also plants a
 * decision with no once-guard and requires the send count to exceed one.
 *
 * Run: node tests/e2e-sas-confirm-backfill.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import {
  SAS_CONFIRM_BACKFILL_FRAMES,
  sasConfirmBackfillDecision,
} from '../lib/sasConfirmBackfill.ts';
import { applyNotifEvents, isUnreadAlert } from '../lib/notificationMerge.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const subtle = webcrypto.subtle;
const K = await import('../lib/e2e/kdf.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok  ${name}`); return; }
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── 1. the decision, as a sequence of published views ───────────────────────
console.log('1. sasConfirmBackfillDecision — once per confirm, effective ON only');

/** Feed a sequence of views through the decision the way the effect does. */
function drive(views, decide = sasConfirmBackfillDecision) {
  let firedFor = null;
  const sent = [];
  for (const v of views) {
    const d = decide(v, firedFor);
    firedFor = d.firedFor;
    sent.push(...d.frames);
  }
  return sent;
}
const ON = (digits, confirmed) => ({ effective: 'on', digits, confirmed });
const OFF = (digits, confirmed) => ({ effective: 'off', digits, confirmed });

eq('frames are exactly GET_NOTIFICATIONS + GET_SYNC_ESTIMATE, plaintext control form',
  [...SAS_CONFIRM_BACKFILL_FRAMES], ['GET_NOTIFICATIONS:{}', 'GET_SYNC_ESTIMATE:{}']);
eq('accept (unconfirmed) sends nothing', drive([ON('31644', false)]), []);
eq('user confirms -> ONE re-send',
  drive([ON('31644', false), ON('31644', true)]), [...SAS_CONFIRM_BACKFILL_FRAMES]);
eq('re-renders + StrictMode double effect after the confirm send nothing more',
  drive([ON('31644', false), ON('31644', true), ON('31644', true), ON('31644', true)]),
  [...SAS_CONFIRM_BACKFILL_FRAMES]);
eq('auto-confirmed accept (digits already confirmed here) counts as a confirm',
  drive([ON('31644', true)]), [...SAS_CONFIRM_BACKFILL_FRAMES]);
eq('a resume recomputing the SAME confirmed digits does not re-send',
  drive([ON('31644', false), ON('31644', true), ON('31644', true)]).length, 2);
eq('a NEW pair (new digits) after the old one ended is a new confirm',
  drive([ON('31644', false), ON('31644', true), OFF(null, false), ON('02024', false), ON('02024', true)]).length, 4);
eq('plain pair (no digits) sends nothing', drive([OFF(null, false), OFF(null, false)]), []);
eq('0/0 sealed pair (effective OFF, gate open at accept) sends nothing',
  drive([OFF('02024', false), OFF('02024', false)]), []);
eq('effective OFF with confirmed digits (e.g. a resume) sends nothing - plain pairs unchanged',
  drive([OFF('02024', true)]), []);
eq('mismatch path (never confirmed) sends nothing', drive([ON('31644', false), OFF(null, false)]), []);

// ── 2. source pins: the wiring and the phone model's two rules ──────────────
console.log('2. wiring + phone-gate pins');
{
  const bridge = stripComments(read('hooks/usePhoneBridge.ts'));
  check('usePhoneBridge imports the decision from lib/sasConfirmBackfill',
    /import \{ sasConfirmBackfillDecision \} from '@\/lib\/sasConfirmBackfill'/.test(bridge));
  const at = bridge.indexOf('sasConfirmBackfillDecision(');
  const eff = bridge.slice(Math.max(0, at - 900), at + 1200);
  check('the effect keys on effective + digits + confirmed (so an auto-confirmed accept fires too)',
    /\}, \[e2eEffective, e2eSasDigits, e2eSasConfirmed\]\);/.test(eff));
  check('the effect stores firedFor in a ref before sending (once-guard survives re-renders)',
    /sasBackfillFiredForRef\.current = d\.firedFor;[\s\S]{0,200}for \(const frame of d\.frames\) ws\.send\(frame\)/.test(eff));
  check('the post-confirm send is NOT behind the once-per-connection estimate guard',
    !/estimateRequestedRef/.test(eff));
  check('the inputs are read off the published e2e view',
    /e2eApi\.e2e\.sas\.digits/.test(eff) && /e2eApi\.e2e\.sas\.confirmed/.test(eff) && /e2eApi\.e2e\.effective/.test(eff));

  const gate = read('dnkdialer-android/app/src/main/java/com/dnkdialer/companion/E2eFrameGate.kt');
  const sealedList = gate.slice(gate.indexOf('SEALED_TYPES'), gate.indexOf('MANDATORY_PLAINTEXT'));
  check('phone model rule 1 (pinned): outbound drops while the code is pending',
    /fun outbound[\s\S]{0,400}sasPendingProvider\(\)/.test(gate));
  check('phone model rule 2 (pinned): inbound drops only SEALED types while pending',
    /sasPendingProvider\(\) && isSealedType\(type\)/.test(gate));
  check('PHONE_NOTIFICATION is sealed on the phone (it is what the gate dropped)',
    /"PHONE_NOTIFICATION"/.test(sealedList));
  check('GET_NOTIFICATIONS / GET_SYNC_ESTIMATE are NOT sealed on the phone (the re-send passes a pending gate)',
    !/"GET_NOTIFICATIONS"/.test(sealedList) && !/"GET_SYNC_ESTIMATE"/.test(sealedList));
  const svc = read('dnkdialer-android/app/src/main/java/com/dnkdialer/companion/PhoneService.kt');
  check('the phone handles GET_NOTIFICATIONS with a backfill (the frame name is real)',
    /"GET_NOTIFICATIONS" -> \{\s*backfillNotifications\("GET_NOTIFICATIONS"\)/.test(svc));
  const web = stripComments(read('hooks/useE2e.ts'));
  const webSealed = web.slice(web.indexOf('SEALED_FRAME_TYPES'), web.indexOf('MANDATORY_PLAINTEXT_FRAME_TYPES'));
  check('the web does not seal the two requests either',
    webSealed.length > 50 && !/'GET_NOTIFICATIONS'/.test(webSealed) && !/'GET_SYNC_ESTIMATE'/.test(webSealed));
}

// ── 3. the scenario: sealed backfill through a real AEAD, into the real merge ─
console.log('3. vc69 / vc70 phone, encrypted pair, confirm -> Alerts');

const V = JSON.parse(read('tests/kdf-vectors.json'));
const J = V.canonicalPeer;
const inputs = K.pairContextFromWire(J.positiveJ1.ctxWire, { userId: J.localUserId });
const sessionKey = webcrypto.getRandomValues(new Uint8Array(32));
const phoneKeys = await K.trafficKeys({ pairingId: inputs.pairingId, sessionKey, context: inputs.contextBytes, role: 'phone' }, subtle);
const pageKeys = await K.trafficKeys({ pairingId: inputs.pairingId, sessionKey, context: inputs.contextBytes, role: 'computer' }, subtle);
const KID = 'kid-fix-a';

const SHADE = [
  { notificationKey: '0|com.bank|1', packageName: 'com.bank', appName: 'Bank', title: 'Card used', body: 'EUR 12.00 at Cafe', postedAt: 1_000 },
  { notificationKey: '0|com.chat|2', packageName: 'com.chat', appName: 'Chat', title: 'Ana', body: 'see you at 6', postedAt: 2_000 },
  { notificationKey: '0|com.mail|3', packageName: 'com.mail', appName: 'Mail', title: 'Invoice', body: 'September', postedAt: 3_000 },
];

async function scenario({ phone, order = 'phone-first', webResend = true, decide = sasConfirmBackfillDecision }) {
  let phoneSasPending = true;
  let seq = 0;
  const wire = [];          // what reached the page (sealed envelopes)
  const requestsAtPhone = [];

  async function phoneBackfill() {
    for (const n of SHADE) {
      if (phoneSasPending) continue; // E2eFrameGate.outbound: sealed + pending -> drop
      const s = seq++;
      const plaintext = new TextEncoder().encode(JSON.stringify({ ...n, backfill: true }));
      const c = await K.seal({ sender: phoneKeys.send, frameType: 'PHONE_NOTIFICATION', kid: KID, seq: s, pairEpoch: inputs.pairEpoch, plaintext }, subtle);
      wire.push({ type: 'PHONE_NOTIFICATION', env: { e: 1, kid: KID, s, c: Buffer.from(c).toString('base64url') } });
    }
  }
  async function phoneInbound(frame) {
    const type = frame.slice(0, frame.indexOf(':'));
    requestsAtPhone.push(type);
    // inbound: only SEALED types are dropped while pending; these are not sealed.
    if (type === 'GET_NOTIFICATIONS') await phoneBackfill();
  }
  async function phoneConfirms() {
    phoneSasPending = false;
    if (phone === 'vc70') await phoneBackfill(); // vc70 backfills on its own confirm
  }

  // The page's side of the view sequence + the effect.
  let firedFor = null;
  async function pagePublishes(view) {
    const d = decide(view, firedFor);
    firedFor = d.firedFor;
    if (!webResend) return;
    for (const f of d.frames) await phoneInbound(f);
  }

  await pagePublishes(ON('31644', false));
  await phoneBackfill();                          // PAIRING_ACTIVE backfill, code pending
  if (order === 'phone-first') await phoneConfirms();
  await pagePublishes(ON('31644', true));         // the user answers "matches" here
  await pagePublishes(ON('31644', true));         // a re-render
  if (order === 'web-first') await phoneConfirms();

  // The page opens every sealed frame and merges it into Alerts.
  let alerts = [];
  let opened = 0;
  let leaked = false;
  for (const f of wire) {
    if (JSON.stringify(f.env).includes('Card used')) leaked = true;
    const plain = await K.open({ receiver: pageKeys.recv, frameType: f.type, kid: f.env.kid, seq: f.env.s, pairEpoch: inputs.pairEpoch, ciphertext: new Uint8Array(Buffer.from(f.env.c, 'base64url')) }, subtle);
    const p = JSON.parse(new TextDecoder().decode(plain));
    opened += 1;
    const notif = {
      id: p.notificationKey, appName: p.appName, packageName: p.packageName, title: p.title, body: p.body,
      timestamp: p.postedAt, hasReply: false, replyKey: '', notificationKey: p.notificationKey, read: false, backfill: true,
    };
    alerts = applyNotifEvents(alerts, [{ type: 'add', notif, backfill: true }]);
  }
  return { alerts, opened, leaked, wire, requestsAtPhone };
}

{
  const r = await scenario({ phone: 'vc69' });
  eq('vc69: exactly ONE GET_NOTIFICATIONS reached the phone', r.requestsAtPhone.filter((t) => t === 'GET_NOTIFICATIONS').length, 1);
  eq('vc69: exactly ONE GET_SYNC_ESTIMATE reached the phone', r.requestsAtPhone.filter((t) => t === 'GET_SYNC_ESTIMATE').length, 1);
  eq('vc69: every shade card arrived SEALED and opened on the page', r.opened, SHADE.length);
  check('vc69: the wire carried envelopes, never the plaintext title', r.wire.length === SHADE.length && !r.leaked);
  eq('vc69: Alerts renders the whole shade', r.alerts.map((n) => n.notificationKey).sort(), SHADE.map((n) => n.notificationKey).sort());
  // #18 fold: ITEM 8 (2619df0, Dennis 2026-09-26) - backfilled cards count as
  // UNREAD until opened/dismissed. Only this unread expectation moved.
  eq('vc69: item 8 - the backfilled shade is UNREAD until opened (unread = shade size)', r.alerts.filter(isUnreadAlert).length, SHADE.length);
}
{
  const r = await scenario({ phone: 'vc70' });
  eq('vc70 (backfills on its own confirm too): the shade crossed the wire TWICE', r.wire.length, SHADE.length * 2);
  eq('vc70: ...and Alerts still holds each card ONCE (no duplicate rows)', r.alerts.length, SHADE.length);
  eq('vc70: no double badge (unread = shade size, never 2x)', r.alerts.filter(isUnreadAlert).length, SHADE.length);
  eq('vc70: still exactly one web re-send', r.requestsAtPhone.filter((t) => t === 'GET_NOTIFICATIONS').length, 1);
}
{
  // A live card the user already sees must not be displaced or duplicated by
  // the replay (applyNotifEvents keeps the incumbent).
  const live = { id: 'x', appName: 'Bank', packageName: 'com.bank', title: 'Card used', body: 'EUR 12.00 at Cafe', timestamp: 9_000, hasReply: false, replyKey: '', notificationKey: '0|com.bank|1', read: false, backfill: false };
  const r = await scenario({ phone: 'vc70' });
  const merged = applyNotifEvents([live], r.alerts.map((notif) => ({ type: 'add', notif, backfill: true })));
  eq('a replayed card matching a live one is discarded (live keeps its slot + unread)',
    // Item 8: the live card keeps its slot; the replay adds no extra unread -
    // unread = the live card + the other backfilled cards = shade size.
    [merged.length, merged[0].backfill, merged.filter(isUnreadAlert).length], [SHADE.length, false, SHADE.length]);
}

// ── 4. controls — the harness can go red ────────────────────────────────────
console.log('4. controls');
{
  const r = await scenario({ phone: 'vc69', webResend: false });
  eq('CONTROL pre-fix page + vc69: Alerts EMPTY (the prod symptom reproduces)', r.alerts.length, 0);
  const noGuard = (v, firedFor) => (v.effective === 'on' && v.confirmed && v.digits
    ? { frames: SAS_CONFIRM_BACKFILL_FRAMES, firedFor } : { frames: [], firedFor });
  const m = await scenario({ phone: 'vc69', decide: noGuard });
  check('CONTROL planted decision without the once-guard sends MORE than once (detector live)',
    m.requestsAtPhone.filter((t) => t === 'GET_NOTIFICATIONS').length > 1);
  const before = failed;
  check('self-test (DELIBERATE - the FAIL line above is this one): a false assertion is recorded', false);
  const detected = failed === before + 1;
  failed = before;
  check('self-test: ...and the counter was restored', detected);
}

const total = passed + failed;
console.log(`e2e-sas-confirm-backfill: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
