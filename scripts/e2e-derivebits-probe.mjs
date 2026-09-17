#!/usr/bin/env node
/**
 * scripts/e2e-derivebits-probe.mjs — the curve decision, measured not assumed.
 *
 * E2E-SPEC §2 needs one answer: can we use X25519 with NON-EXTRACTABLE keys in
 * the browsers we actually ship to, or do we fall back to P-256 ECDH?
 *
 * It has to be measured in a real Chromium because every part of it is a
 * browser-version question. X25519 arrived in WebCrypto late and behind
 * different names at different times ("X25519" vs the older "NODE-X25519"),
 * Node's WebCrypto and Chrome's do not agree on what is implemented, and — the
 * part that actually decides the design — `extractable: false` is enforced by
 * the browser, not by the algorithm. A key we can export is a key our own code
 * can leak, and §9.2 blocks the claim on "keys recoverable by us".
 *
 * So each probe below asks for the exact thing production would ask for:
 * generateKey with extractable:false, then deriveBits, then a deliberate
 * exportKey that MUST throw. A probe that only generated a key would report
 * "X25519 available" for a browser that hands the private key to anyone.
 *
 * Usage:  node scripts/e2e-derivebits-probe.mjs [--json]
 * Writes nothing. Prints a block to paste into E2E-SPEC §2.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';

const JSON_ONLY = process.argv.includes('--json');

/**
 * `crypto.subtle` exists ONLY in a secure context. page.setContent() leaves the
 * page on an opaque origin, where `crypto.subtle` is undefined — and a probe
 * that ran there would report "X25519 unavailable" for every browser on earth
 * and talk us into the P-256 fallback for no reason. http://127.0.0.1 is a
 * potentially-trustworthy origin, so serving one line of HTML from a throwaway
 * loopback server is what makes the answer mean anything.
 *
 * The probe asserts `isSecureContext` before trusting a negative result.
 */
const serveOnce = () =>
  new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>probe</title>');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

const probe = async () => {
  const { server, port } = await serveOnce();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

  if (!(await page.evaluate(() => isSecureContext && !!globalThis.crypto?.subtle))) {
    await browser.close(); server.close();
    throw new Error('probe aborted: not a secure context / no crypto.subtle — a negative result here would be meaningless');
  }

  const result = await page.evaluate(async () => {
    const out = { userAgent: navigator.userAgent, secureContext: isSecureContext, algorithms: {} };

    async function tryAlg(label, genParams, deriveName) {
      const r = {
        generateNonExtractable: false,
        deriveBits: false,
        privateKeyIsNonExtractable: false,
        publicKeyExportable: false,
        bits: null,
        error: null,
      };
      try {
        const a = await crypto.subtle.generateKey(genParams, false, ['deriveBits']);
        const b = await crypto.subtle.generateKey(genParams, false, ['deriveBits']);
        r.generateNonExtractable = true;
        r.privateKeyExtractableFlag = a.privateKey.extractable;

        const bits = await crypto.subtle.deriveBits(
          { name: deriveName, public: b.publicKey }, a.privateKey, 256,
        );
        r.deriveBits = true;
        r.bits = new Uint8Array(bits).length * 8;

        // The load-bearing assertion: a non-extractable private key must REFUSE
        // to export. If this succeeds, extractable:false bought us nothing.
        try {
          await crypto.subtle.exportKey('pkcs8', a.privateKey);
          r.privateKeyIsNonExtractable = false;
        } catch {
          r.privateKeyIsNonExtractable = true;
        }

        // The PUBLIC key must still export — we have to send it to the peer.
        try {
          await crypto.subtle.exportKey('raw', a.publicKey);
          r.publicKeyExportable = true;
        } catch {
          try { await crypto.subtle.exportKey('spki', a.publicKey); r.publicKeyExportable = true; }
          catch { r.publicKeyExportable = false; }
        }

        // Two independent pairs must agree on the shared secret, or "deriveBits
        // worked" means only "it returned some bytes".
        const ab = new Uint8Array(await crypto.subtle.deriveBits({ name: deriveName, public: b.publicKey }, a.privateKey, 256));
        const ba = new Uint8Array(await crypto.subtle.deriveBits({ name: deriveName, public: a.publicKey }, b.privateKey, 256));
        r.ecdhAgrees = ab.length === ba.length && ab.every((x, i) => x === ba[i]);
      } catch (e) {
        r.error = String((e && e.message) || e);
      }
      out.algorithms[label] = r;
    }

    await tryAlg('X25519', { name: 'X25519' }, 'X25519');
    await tryAlg('P-256', { name: 'ECDH', namedCurve: 'P-256' }, 'ECDH');

    // HKDF is what the SAS and every key schedule run through. If it is missing
    // the curve question is moot.
    out.hkdf = { available: false, error: null };
    try {
      const k = await crypto.subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(8), info: new TextEncoder().encode('cc-sas-v1') }, k, 32,
      );
      out.hkdf.available = new Uint8Array(bits).length === 4;
    } catch (e) {
      out.hkdf.error = String((e && e.message) || e);
    }

    // AES-GCM with a non-extractable key — the AEAD the sealed frames use.
    out.aesGcm = { nonExtractable: false, error: null };
    try {
      const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode('probe'));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct);
      out.aesGcm.roundTrip = new TextDecoder().decode(pt) === 'probe';
      try { await crypto.subtle.exportKey('raw', k); out.aesGcm.nonExtractable = false; }
      catch { out.aesGcm.nonExtractable = true; }
    } catch (e) {
      out.aesGcm.error = String((e && e.message) || e);
    }

    return out;
  });

  result.chromeVersion = browser.version();
  await browser.close();
  server.close();
  return result;
};

const r = await probe();

const x = r.algorithms['X25519'];
const p = r.algorithms['P-256'];
const usable = (a) => Boolean(a && a.generateNonExtractable && a.deriveBits && a.privateKeyIsNonExtractable && a.publicKeyExportable && a.ecdhAgrees);

const decision = usable(x) ? 'X25519' : usable(p) ? 'P-256 (fallback)' : 'NEITHER — escalate';

if (JSON_ONLY) {
  console.log(JSON.stringify({ ...r, decision }, null, 2));
} else {
  console.log(`
E2E-SPEC §2 — curve probe (paste this block)
────────────────────────────────────────────────────────────────
Chromium        : ${r.chromeVersion}
UA              : ${r.userAgent}
Secure context  : ${r.secureContext}

X25519          : generateKey(extractable:false) ${x.generateNonExtractable ? 'OK' : 'NO'}
                  deriveBits(256)                ${x.deriveBits ? `OK (${x.bits} bits)` : 'NO'}
                  both sides agree               ${x.ecdhAgrees ? 'OK' : 'NO'}
                  private key export REFUSED     ${x.privateKeyIsNonExtractable ? 'OK' : 'NO — key is exportable'}
                  public key exportable          ${x.publicKeyExportable ? 'OK' : 'NO'}
                  ${x.error ? `error: ${x.error}` : ''}

P-256 (ECDH)    : generateKey(extractable:false) ${p.generateNonExtractable ? 'OK' : 'NO'}
                  deriveBits(256)                ${p.deriveBits ? `OK (${p.bits} bits)` : 'NO'}
                  both sides agree               ${p.ecdhAgrees ? 'OK' : 'NO'}
                  private key export REFUSED     ${p.privateKeyIsNonExtractable ? 'OK' : 'NO — key is exportable'}
                  public key exportable          ${p.publicKeyExportable ? 'OK' : 'NO'}
                  ${p.error ? `error: ${p.error}` : ''}

HKDF-SHA256     : ${r.hkdf.available ? 'OK' : `NO — ${r.hkdf.error}`}
AES-GCM         : round-trip ${r.aesGcm.roundTrip ? 'OK' : 'NO'}, non-extractable ${r.aesGcm.nonExtractable ? 'OK' : 'NO'}

DECISION        : ${decision}
────────────────────────────────────────────────────────────────
`);
}

process.exit(decision === 'NEITHER — escalate' ? 1 : 0);
