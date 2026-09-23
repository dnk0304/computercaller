/**
 * scripts/lib/scripted-phone.mjs — a scripted PHONE half, extracted from
 * scripts/e2e-live-peer-proof.mjs's `phoneAccept()` (~line 213) into a
 * standalone, reusable function.
 *
 * It builds a VALID PAIRING_ACTIVE payload — the `e2e` accept block (P4's wire
 * shape) plus its `ctx` (GATE1 Addendum A3/A4) — that `hooks/useE2e.ts`'s
 * `onPairingActive()` will accept, derive keys from, and produce SAS digits
 * for. Nothing here is a new format: every field and every derivation step is
 * lifted from the working harness (which passes 70/70) and from reading
 * `hooks/phoneE2e.ts` (`readAcceptBlock`, `decideAccept`, `sasKeySet`) for the
 * exact shape the web side parses.
 *
 * WHAT IS DERIVED vs GUESSED:
 *  - `ctx.peerDeviceId` is derived via `canonicalPeerDeviceId()` over the
 *    wraps[] this call actually emits (A4-R2), never a caller-supplied value.
 *  - `ctx.pairEpoch` is emitted as a DECIMAL STRING (A3), never a JSON number.
 *  - `ctx.userId` is NEVER put on the wire (A3) — the `userId` parameter here
 *    is used only as CONTEXT.userId inside pairContext, matching CONTEXT in
 *    the harness; it is not the "local session userId" the receiver supplies
 *    separately when it calls pairContextFromWire.
 *  - `expectedSasDigits` is computed with the real `sasDigits()` over the
 *    same transcript the web recomputes: pairingId salt, epk, the FULL
 *    deduped/sorted key set (phone + every recipient), pairEpoch, modeByte.
 *
 * GUESSED / NOT DERIVABLE FROM THE SPEC FILES (see the report for detail):
 *  - The phone's own static keypair is freshly minted per call (mirroring
 *    `mintKeyPair()` in the harness) since the caller does not hand us one;
 *    it is returned as `phonePub` so a caller can register/pin it if needed.
 *  - The `deviceName` field on the PAIRING_ACTIVE payload is cosmetic (the
 *    harness uses 'Harness Phone'); useE2e.ts never reads it.
 */

import * as KDF from '../../lib/e2e/kdf.mjs';
import * as SESSION from '../../lib/e2e/session.mjs';
import { sasDigits } from '../../lib/e2e/sas.mjs';

const b64 = SESSION.toBase64Url;

async function mintKeyPair() {
  const p = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', p.publicKey));
  return { priv: p.privateKey, pub, b64: b64(pub) };
}

/**
 * Build a VALID PAIRING_ACTIVE payload as the phone would emit it.
 *
 * @param {object} args
 * @param {{deviceId: string, kind: 'web'|'extension', pub: string}[]} args.recipients
 *   The recipient set exactly as it arrived on PAIRING_REQUEST's e2e.recips —
 *   `pub` is each recipient's static X25519/P-256 public key, base64url SEC1.
 * @param {string} args.pairingId
 * @param {number|bigint} args.pairEpoch
 * @param {boolean} args.modeOn
 * @param {string} args.userId       CONTEXT.userId used inside pairContext (matches the phone's view).
 * @param {string} args.phoneDeviceId
 * @returns {Promise<{payload: object, expectedSasDigits: string, phonePub: string}>}
 */
export async function scriptedPhoneAccept({ recipients, pairingId, pairEpoch, modeOn, userId, phoneDeviceId }) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('scriptedPhoneAccept: recipients must be a non-empty array');
  }

  const phoneKey = await mintKeyPair();

  // A4-M2: ctx.peerDeviceId is the canonical-lowest of the wraps[] THIS call
  // ships, computed over that shipped set — not over recipKeys[] (which also
  // contains the phone's own key) and not over caller-supplied order.
  const wrapDeviceIds = recipients.map((r) => ({ deviceId: r.deviceId }));
  const peerDeviceId = KDF.canonicalPeerDeviceId(wrapDeviceIds);

  const ctxInput = { userId, phoneDeviceId, peerDeviceId, pairEpoch };
  const ctx = KDF.pairContext(ctxInput);

  const sk = crypto.getRandomValues(new Uint8Array(32));
  const kid = b64(crypto.getRandomValues(new Uint8Array(16)));
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const wraps = [];
  for (const r of recipients) {
    const peer = await crypto.subtle.importKey('raw', SESSION.fromBase64Url(r.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const z = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256));
    const kekBytes = await KDF.kek({ pairingId, sharedSecret: z, context: ctx, recipientKey: SESSION.fromBase64Url(r.pub) });
    const kekKey = await crypto.subtle.importKey('raw', kekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = await KDF.seal({
      sender: { direction: SESSION.DIR_P2C, key: kekKey, sessionPrefix: await SESSION.wrapPrefix(r.deviceId) },
      frameType: SESSION.WRAP_FRAME_TYPE, kid, seq: 0, pairEpoch, plaintext: sk,
    });
    z.fill(0); kekBytes.fill(0);
    wraps.push({ deviceId: r.deviceId, wrap: b64(ct) });
  }

  // recipKeys is the FULL static-key set: phone first, then every recipient's
  // key, in the shape hooks/phoneE2e.ts's readAcceptBlock() / isPinned()
  // expects (each a base64url-encoded 65-byte 0x04-prefixed SEC1 point).
  const recipKeys = [phoneKey.b64, ...recipients.map((r) => r.pub)];

  const block = {
    v: 1,
    mode: modeOn ? 1 : 0,
    kid,
    epk: b64(epk),
    recipKeys,
    wraps,
    /*
     * A3's ratified wire form: pairEpoch is a DECIMAL STRING, userId is
     * deliberately ABSENT.
     *
     * EMITTED UNCONDITIONALLY, and the `modeOn ?` gate that used to stand here
     * was a HARNESS BUG of exactly the kind SAS-MODE0 fixes in the product: it
     * read the MODE BYTE as "is this pair sealing". It is not. Under A5 /
     * M-A5-5(2) a usable block on both sides SEALS whatever the byte says — the
     * byte governs VERIFICATION — so a mode-0 pair derives keys and therefore
     * needs the context to derive them from. With the gate in place a 0/0 pair
     * could not seal at all: hooks/useE2e.ts refused it with
     * `e2e-setup-failed — ctx refused: kdf: ctx is absent`, the pair errored,
     * and a harness case asserting "no SAS dialog" passed for the WRONG REASON
     * (an aborted pair shows no dialog either).
     *
     * The SHIPPED phone is the authority and it does not gate: PhoneService.kt
     * calls `E2ePairIdentity.withCtx(prepared.block, pairContext)` on every
     * accept, with no mode test ("without it ... nothing the phone seals is
     * openable off-device"). A scripted phone that behaves differently is not
     * modelling the phone.
     *
     * A3-M4 ("a mode=1 block with no ctx MUST be refused") is a rule about what
     * a RECEIVER must reject. It was misread here as licence for a sender to
     * omit it.
     */
    ctx: {
      pairingId,
      phoneDeviceId,
      peerDeviceId,
      pairEpoch: String(pairEpoch),
    },
  };

  // The PAIRING_ACTIVE payload as the relay forwards it: the accept block
  // verbatim under `e2e`, plus the pairingId the relay already owns. See
  // server.js's ACCEPT_PAIRING handler / the harness's startRelay().
  const payload = {
    deviceName: 'Scripted Phone',
    pairingId,
    ...(block.mode === 1 || wraps.length ? { e2e: block } : {}),
  };

  // The SAS transcript covers the FULL key set (B9) — recipKeys, which
  // already includes the phone's own key plus every recipient's.
  const expectedSasDigits = await sasDigits({
    pairingId,
    epk,
    keys: recipKeys.map(SESSION.fromBase64Url),
    pairEpoch,
    modeOn: true,
  });

  return { payload, expectedSasDigits, phonePub: phoneKey.b64 };
}
