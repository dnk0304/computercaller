#!/usr/bin/env node
/**
 * scripts/e2e-resume-phone-restart-proof.mjs — T-RESUME-PHONE-RESTART-DESYNC,
 * the RELAY CONTRACT half (Ken's brief, "Relay contract test").
 *
 * The unit contract (tests/e2e-resume-phone-restart-contract.test.mjs) drives
 * the shipped predicates directly and pins that server.js calls them. This file
 * proves the other thing a source pin cannot: that the REAL relay, booted from
 * this tree as its own process against a scratch Postgres, reaches the right
 * OUTCOME on the wire for the force-stop path.
 *
 *   A. FORCE-STOP — a verified pair, the phone's socket closes, the phone
 *      re-joins WITHOUT a session (`?session=0`, what a fresh process sends).
 *      The browser must receive PAIRING_TERMINATED {reason:'phone_restarted'}
 *      inside the hold — not silence for 180 s, and not a resume.
 *   B. BLIP — the same drop, but the phone re-joins declaring the pair's kid.
 *      The pair must RESUME (PAIRING_ACTIVE resumed:true), because a fix that
 *      broke this would cost every user a re-pair on every cellular hiccup.
 *   C. BOTH away, phone back healthy — the reload-after-a-blip shape, and the
 *      only one where the PAGE itself receives a resumed PAIRING_ACTIVE about a
 *      phone that re-joined. So it is the only place `peerSession` is
 *      observable on the wire, which is exactly why the page's check has to
 *      tolerate its absence everywhere else.
 *   D. BOTH away, phone back RESTARTED — the hole that keying the gate on the
 *      claim's `droppedRole` would have left: the LAST close there is the
 *      BROWSER's, so a droppedRole test reads 'browser' and waves a
 *      session-less phone straight into the sealed pair. D also covers the
 *      no-active-slot notify path: terminateActivePair returns early when
 *      room.active is empty, so the returning browser is told directly.
 *
 * The LEAVE_ACTIVE-during-hold half of the ticket is NOT provable on this wire
 * and is stated as such rather than faked: a returning phone is resumed (or
 * refused) AT JOIN, so there is no reachable moment where a phone sits in the
 * lobby of a live phone-dropped hold with an interactive browser survivor. It
 * is held by the five vector rows in the unit contract plus the server.js
 * source pin on that branch.
 *
 * Run: node scripts/e2e-resume-phone-restart-proof.mjs
 * Needs: the scratch Postgres the other P6 proofs use (localhost:15433/cc_p6).
 */
import crypto from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failed += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A structurally valid e2e ACCEPT block: the relay pins the ENCODING, never the meaning. */
function makeBlock(kid) {
  const pub = () => Buffer.concat([Buffer.from([0x04]), crypto.randomBytes(64)]).toString('base64url');
  return {
    v: 1,
    mode: 1,
    kid,
    epk: pub(),
    recipKeys: [pub(), pub()],
    wraps: [{ deviceId: 'web-dev-1', wrap: crypto.randomBytes(48).toString('base64url') }],
    ctx: { pairingId: 'p', phoneDeviceId: 'phone-dev-1', peerDeviceId: 'web-dev-1', pairEpoch: '1' },
  };
}

async function main() {
  let relayMod; let wsMod; let PrismaMod;
  try {
    relayMod = await import('./lib/real-relay.mjs');
    wsMod = await import('ws');
    PrismaMod = await import('@prisma/client');
  } catch (e) {
    check('R0  real-relay prerequisites available', false, e.message);
    return;
  }
  const { withRealRelay } = relayMod;
  const { WebSocket } = wsMod;

  const DB = 'postgresql://pix:pix@localhost:15433/cc_p6';
  const JWT_SECRET = 'resume-desync-harness-secret-0123456789abcdef';
  const phoneToken = crypto.randomBytes(32).toString('base64url');
  const db = new PrismaMod.PrismaClient({ datasources: { db: { url: DB } } });

  try {
    await db.user.create({
      data: {
        email: `resume-desync-${Date.now()}@harness.invalid`,
        phoneToken, isAdmin: true, emailVerified: true,
      },
    });
    check('R0  scratch user seeded in cc_p6', true);
  } catch (e) {
    check('R0  scratch user seeded in cc_p6', false, String(e.message).split('\n').slice(-3).join(' '));
    await db.$disconnect();
    return;
  }

  try {
    await withRealRelay({
      cwd: ROOT,
      logDir: 'C:/Users/D/worktrees/computercaller/resume-phone-restart-logs',
      databaseUrl: DB,
      env: { E2E_PAIRING_ENABLED: '1', JWT_SECRET },
      timeoutMs: 90_000,
      label: 'resume-desync',
    }, async (relay) => {
      check('R1  real relay booted (node server.js, own pid, ephemeral port)', !!relay.port, `port=${relay.port}`);

      const open = (p, extra = '') => new Promise((res, rej) => {
        const ws = new WebSocket(`${relay.wsBase}${p}?token=${encodeURIComponent(phoneToken)}${extra}`);
        const t = setTimeout(() => rej(new Error(`timeout opening ${p}`)), 20_000);
        ws.on('open', () => { clearTimeout(t); res(ws); });
        ws.on('error', (e) => { clearTimeout(t); rej(e); });
      });
      const waitFor = (ws, prefix, ms = 20_000) => new Promise((res, rej) => {
        const on = (d) => {
          const s = d.toString();
          if (s.startsWith(prefix)) { clearTimeout(t); ws.off('message', on); res(s); }
        };
        const t = setTimeout(() => { ws.off('message', on); rej(new Error(`timeout waiting for ${prefix}`)); }, ms);
        ws.on('message', on);
      });
      const settle = (ms) => new Promise((r) => setTimeout(r, ms));

      /** Form a REAL sealed pair and return the live sockets. */
      async function formSealedPair(kid, phoneExtra = '') {
        const browser = await open('/relay');
        const phone = await open('/relay/phone', phoneExtra);
        let req = null;
        for (let attempt = 0; attempt < 8 && !req; attempt++) {
          await settle(500);
          const seen = waitFor(phone, 'PAIRING_REQUEST', 1500).catch(() => null);
          browser.send(`BROWSER_REQUEST_PAIRING:${JSON.stringify({ ua: 'resume-desync-harness', e2e: { v: 1, mode: 1, recips: [{ kind: 'web', deviceId: 'web-dev-1', pub: makeBlock('x').epk }] } })}`);
          req = await seen;
        }
        if (!req) throw new Error('relay never forwarded PAIRING_REQUEST after 8 attempts');
        const { pairingId } = JSON.parse(req.slice('PAIRING_REQUEST:'.length));
        const active = waitFor(browser, 'PAIRING_ACTIVE');
        phone.send(`ACCEPT_PAIRING:${JSON.stringify({ pairingId, e2e: makeBlock(kid) })}`);
        const frame = JSON.parse((await active).slice('PAIRING_ACTIVE:'.length));
        return { browser, phone, frame };
      }

      // ── A. FORCE-STOP ───────────────────────────────────────────────────
      {
        const KID = 'kid-forcestop-A';
        const { browser, phone, frame } = await formSealedPair(KID, '&session=0');
        check('A1  a real SEALED pair formed (the relay stashed the block)',
          !!frame.e2e && frame.e2e.kid === KID, JSON.stringify(frame.e2e && frame.e2e.kid));

        // The phone is FORCE-STOPPED: its socket dies, the relay arms the hold.
        const heldSeen = waitFor(browser, 'PEER_RECONNECTING', 10_000).catch(() => null);
        phone.close();
        const held = await heldSeen;
        check('A2  the relay soft-held the browser (PEER_RECONNECTING droppedRole=phone)',
          !!held && JSON.parse(held.slice('PEER_RECONNECTING:'.length)).droppedRole === 'phone',
          held ? held.slice(0, 120) : 'no PEER_RECONNECTING');

        // It comes back a FRESH PROCESS — no session. This is the exact frame
        // the incident produced 13 ms after the force-stop.
        const terminated = waitFor(browser, 'PAIRING_TERMINATED', 15_000).catch(() => null);
        const resumedInstead = waitFor(browser, 'PAIRING_ACTIVE', 15_000).catch(() => null);
        // Registered BEFORE the rejoin: LOBBY_STATUS follows PAIRING_TERMINATED
        // in the same tick, and a waiter attached afterwards has already missed
        // it — a harness artefact that would read as "the browser was stranded".
        const lobbySeen = waitFor(browser, 'LOBBY_STATUS', 15_000).catch(() => null);
        const phone2 = await open('/relay/phone', '&session=0');
        const t = await terminated;
        check('A3  the browser was told the pair is over, inside the hold (not 180 s of silence)', !!t,
          'no PAIRING_TERMINATED within 15 s');
        check('A4  ...with reason=phone_restarted',
          !!t && JSON.parse(t.slice('PAIRING_TERMINATED:'.length)).reason === 'phone_restarted',
          t ? t.slice(0, 140) : '');
        check('A5  ...and the pair was NOT resumed', (await resumedInstead) === null,
          'a PAIRING_ACTIVE arrived — the relay resumed a restarted phone');
        // The browser is back in the lobby, so Connect is offered again.
        check('A6  ...and the browser was returned to the lobby', !!(await lobbySeen), 'no LOBBY_STATUS');
        try { browser.close(); phone2.close(); } catch { /* closing */ }
        await settle(800);
      }

      // ── B. BLIP ─────────────────────────────────────────────────────────
      {
        const KID = 'kid-blip-B';
        const { browser, phone, frame } = await formSealedPair(KID, `&session=${encodeURIComponent(KID)}`);
        check('B1  a second real SEALED pair formed', !!frame.e2e && frame.e2e.kid === KID);

        const heldSeen = waitFor(browser, 'PEER_RECONNECTING', 10_000).catch(() => null);
        phone.close();
        await heldSeen;

        // Same drop, but the process LIVED: it declares the pair's kid. The
        // SURVIVOR browser is deliberately not re-sent PAIRING_ACTIVE (it never
        // left active), so the returning PHONE is where the resume is visible.
        const terminatedWrongly = waitFor(browser, 'PAIRING_TERMINATED', 12_000).catch(() => null);
        const phone2 = await open('/relay/phone', `&session=${encodeURIComponent(KID)}`);
        const r = await waitFor(phone2, 'PAIRING_ACTIVE', 15_000).catch(() => null);
        check('B2  a genuine blip still RESUMES (PAIRING_ACTIVE resumed:true, no re-Accept)',
          !!r && JSON.parse(r.slice('PAIRING_ACTIVE:'.length)).resumed === true,
          r ? r.slice(0, 160) : 'no PAIRING_ACTIVE within 15 s');
        check('B3  ...and the browser was NOT told the pair ended', (await terminatedWrongly) === null);
        const payload = r ? JSON.parse(r.slice('PAIRING_ACTIVE:'.length)) : {};
        check('B4  ...re-sending the SAME block (same kid)', !!payload.e2e && payload.e2e.kid === KID);
        try { browser.close(); phone2.close(); } catch { /* closing */ }
        await settle(1000);
      }

      // ── C. BOTH SIDES AWAY, phone returns healthy -> the BROWSER is told ──
      // This is the reload-after-a-blip shape, and the only one where the page
      // itself receives a resumed PAIRING_ACTIVE about a phone that RE-JOINED.
      // It is therefore the only place `peerSession` can be observed on the
      // wire, which is precisely why the page's check has to tolerate its
      // absence everywhere else.
      {
        const KID = 'kid-both-C';
        const { browser, phone, frame } = await formSealedPair(KID, `&session=${encodeURIComponent(KID)}`);
        check('C1  a third real SEALED pair formed', !!frame.e2e && frame.e2e.kid === KID);
        phone.close();
        await settle(400);
        browser.close();
        await settle(800);
        // ORDER MATTERS, and getting it wrong is a harness race rather than a
        // product fact: whoever arrives SECOND is the join that runs
        // tryAutoResume, and the frame goes to the sockets it finds at that
        // moment. With the phone second, the browser is already in the lobby
        // and is a socket the relay can actually reach.
        const browser2 = await open('/relay');
        await settle(600);
        const r2seen = waitFor(browser2, 'PAIRING_ACTIVE', 15_000).catch(() => null);
        const phone2 = await open('/relay/phone', `&session=${encodeURIComponent(KID)}`);
        const r = await r2seen;
        const payload = r ? JSON.parse(r.slice('PAIRING_ACTIVE:'.length)) : {};
        check('C2  the browser gets a resumed PAIRING_ACTIVE', payload.resumed === true,
          r ? r.slice(0, 160) : 'no PAIRING_ACTIVE within 15 s');
        check("C3  ...carrying peerSession, the page's re-verification input",
          !!payload.peerSession && payload.peerSession.present === true, JSON.stringify(payload.peerSession));
        check('C4  ...naming the kid the page compares against its own',
          !!payload.peerSession && payload.peerSession.kid === KID, JSON.stringify(payload.peerSession));
        try { browser2.close(); phone2.close(); } catch { /* closing */ }
        await settle(1000);
      }

      // ── D. BOTH SIDES AWAY, phone returns RESTARTED ──────────────────────
      // The hole that keying the gate on claim.droppedRole would have left: the
      // LAST close here is the BROWSER's, so a droppedRole test would have read
      // 'browser' and waved a session-less phone straight through into the
      // sealed pair. The gate is keyed on whether the PHONE returned instead.
      {
        const KID = 'kid-both-D';
        const { browser, phone, frame } = await formSealedPair(KID, `&session=${encodeURIComponent(KID)}`);
        check('D1  a fourth real SEALED pair formed', !!frame.e2e && frame.e2e.kid === KID);
        phone.close();
        await settle(400);
        browser.close();
        await settle(800);
        // Browser first, for the reason spelled out in C: the phone's join is
        // the one that runs the gate, and the browser must already be a socket
        // the relay can reach when it does.
        const browser2 = await open('/relay');
        await settle(600);
        const tSeen = waitFor(browser2, 'PAIRING_TERMINATED', 15_000).catch(() => null);
        const phone2 = await open('/relay/phone', '&session=0');   // force-stopped
        const t = await tSeen;
        check("D2  the restarted phone is refused even though the LAST close was the browser's", !!t,
          'no PAIRING_TERMINATED — a session-less phone was resumed into a sealed pair');
        check('D3  ...with reason=phone_restarted',
          !!t && JSON.parse(t.slice('PAIRING_TERMINATED:'.length)).reason === 'phone_restarted',
          t ? t.slice(0, 140) : '');
        try { browser2.close(); phone2.close(); } catch { /* closing */ }
        await settle(800);
      }
    });
  } catch (e) {
    check('R*  real-relay wire slice completed', false, String(e?.stack ?? e).split('\n').slice(0, 4).join(' | '));
  } finally {
    try { await db.user.deleteMany({ where: { phoneToken } }); } catch { /* scratch db */ }
    await db.$disconnect();
  }
}

main().then(() => {
  console.log('');
  console.log(`e2e-resume-phone-restart-proof: ${passed}/${passed + failed} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}, (e) => {
  console.error(e);
  process.exit(1);
});
