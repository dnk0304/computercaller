/**
 * Shared MV3 service-worker discovery for the extension harnesses.
 * (E2E-P5a slice 1, deliverable (a) — R-C's "source fix".)
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * Every ext-* harness used to open with some variant of
 *
 *     for (let i = 0; i < 60 && !sw; i++) { sw = ctx.serviceWorkers()[0]; await sleep(500); }
 *     if (!sw) throw new Error('service worker never registered');
 *
 * `ctx.serviceWorkers()` lists only RUNNING workers. An MV3 worker is
 * event-driven: it is registered at install time and then idles, with nothing
 * to run. So the loop above conflates three completely different states —
 *
 *   1. the extension failed to load          (a real failure)
 *   2. the worker is still starting up       (wait longer)
 *   3. the worker is registered and IDLE     (poke it; it will never appear)
 *
 * — and reports all three as "service worker never registered". State 3 is the
 * common one on a loaded box, which is why P3 saw the message chronically and
 * why ext-badge-counter-proof scored 42/42 for one lane and 34/42 for another
 * on the same commit (e2e/LEARNINGS.md, 2026-09-17 P3 finding).
 *
 * THE FIX
 * -------
 * Wake it the way a user does — open one of the extension's own pages, which
 * fires onConnect/onMessage and starts the worker — and only then poll. A
 * worker that is still absent after the wake AND the bounded wait is genuinely
 * broken, and the error now says which of the three states we ended in.
 *
 * This changes no assertion in any harness. It changes only how the harness
 * obtains the `sw` handle it was already asserting against.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The classic path-hash extension ID: SHA-256 of the absolute path, first 16
 * bytes, each nibble mapped 0-f → a-p.
 *
 * Exported for diagnostics only. It does NOT reliably reproduce the ID Chrome
 * assigns a `--load-extension` extension, so discoverExtensionId() does not use
 * it — see the note at the bottom of that function.
 */
export function unpackedExtensionId(extDir) {
  const enc = process.platform === 'win32' ? 'utf16le' : 'utf8';
  const digest = createHash('sha256').update(Buffer.from(extDir, enc)).digest('hex').slice(0, 32);
  return [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * Best-effort extension ID from a live context, cheapest source first.
 * Returns null only if the extension really is not installed.
 */
export async function discoverExtensionId(ctx, extDir = null) {
  const fromUrl = (u) => {
    const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(u || '');
    return m ? m[1] : null;
  };
  for (const w of ctx.serviceWorkers()) { const id = fromUrl(w.url()); if (id) return id; }
  for (const p of ctx.backgroundPages?.() || []) { const id = fromUrl(p.url()); if (id) return id; }
  for (const p of ctx.pages()) { const id = fromUrl(p.url()); if (id) return id; }

  // chrome://extensions-internals renders the installed-extension list as JSON.
  // It is a real browser page, so it works even when nothing of the extension
  // is running yet.
  //
  // MATCH ON THE PATH, not on "the first plausible id". Every Chrome profile
  // ships component extensions, and the first entry in that list is the Chrome
  // Web Store (ahfgeienlihckogmohjhadlkjgocpleb). Taking it produced a
  // beautifully specific and completely wrong error — "extension ahfgeien… is
  // installed but its service worker did not start" — for an extension that
  // has no service worker and was never under test.
  const want = extDir ? path.resolve(extDir).replace(/\\/g, '/').toLowerCase() : null;
  try {
    const probe = await ctx.newPage();
    try {
      await probe.goto('chrome://extensions-internals', { timeout: 10_000 });
      const raw = await probe.evaluate(() => document.body.innerText);
      const parsed = JSON.parse(raw);
      const all = (Array.isArray(parsed) ? parsed : []).filter((e) => /^[a-p]{32}$/.test(e?.id || ''));
      const samePath = want && all.find((e) => String(e.path || '').replace(/\\/g, '/').toLowerCase() === want);
      if (samePath) return samePath.id;
      // No path match: take the loaded-from-disk entry rather than whatever
      // came first. `location` is a string here — COMPONENT for the two Chrome
      // ships (Web Store, PDF Viewer), COMMAND_LINE for a --load-extension one.
      const unpacked = all.find((e) => /COMMAND_LINE|UNPACKED/i.test(String(e.location || '')));
      if (unpacked) return unpacked.id;
    } finally {
      await probe.close().catch(() => {});
    }
  } catch { /* nothing else to try */ }

  /**
   * Deliberately NOT falling back to unpackedExtensionId() here.
   *
   * Chrome's ID for a --load-extension extension is not the plain path hash
   * that function computes (measured: it returns `emnnnlj…` where Chrome
   * assigned `helkcjjl…`), so using it would hand the caller a well-formed,
   * confidently-wrong ID — which is exactly how this helper's first version
   * spent 90 seconds waiting for the Chrome Web Store's non-existent service
   * worker and then blamed the extension under test. Returning null makes the
   * caller say "the extension did not load", which is the true statement when
   * chrome://extensions-internals lists nothing.
   */
  return null;
}

/**
 * Get a handle on the extension's MV3 service worker, waking it if it is
 * registered-but-idle.
 *
 * @param {import('playwright').BrowserContext} ctx
 * @param {string|null} extensionId  known ID, or null to discover one
 * @param {object}  [opts]
 * @param {boolean} [opts.wake=true]        open an extension page to start the worker
 * @param {number}  [opts.timeoutMs=90000]  total budget for the whole operation
 * @param {string}  [opts.extDir=null]      extension dir, for the computed-ID fallback
 * @param {string}  [opts.wakePage='popup.html']
 * @param {number}  [opts.settleMs=1200]    let the worker finish its top-level run
 * @returns {Promise<import('playwright').Worker>}
 * @throws  {Error} with a message that distinguishes "not installed" from
 *                  "installed but the worker would not start".
 */
export async function awaitServiceWorker(ctx, extensionId = null, opts = {}) {
  const {
    wake = true,
    timeoutMs = 90_000,
    extDir = null,
    wakePage = 'popup.html',
    settleMs = 1200,
  } = opts;
  const deadline = Date.now() + timeoutMs;

  // Already running? Nothing to do.
  let sw = ctx.serviceWorkers()[0] || null;
  if (sw) { await sleep(settleMs); return sw; }

  const id = extensionId || (await discoverExtensionId(ctx, extDir));

  // A short poll FIRST: the worker often starts on its own right after install,
  // and waking is pointless once it has.
  for (let i = 0; i < 10 && !sw && Date.now() < deadline; i += 1) {
    sw = ctx.serviceWorkers()[0] || null;
    if (!sw) await sleep(500);
  }

  if (!sw && wake && id) {
    // Opening an extension page starts the worker: the page's connection is an
    // extension event, and popup.html's own scripts message the worker. This is
    // the same path a user's click takes, not a test-only backdoor.
    try {
      const nudge = await ctx.newPage();
      try {
        await nudge.goto(`chrome-extension://${id}/${wakePage}`, { timeout: 15_000 });
        // Belt and braces: an explicit runtime message guarantees an onMessage
        // event even if popup.html happens to send none. Errors are expected
        // and ignored — an unhandled message type still woke the worker.
        await nudge.evaluate(() => new Promise((r) => {
          try { chrome.runtime.sendMessage({ type: '__e2e_wake__' }, () => { void chrome.runtime.lastError; r(); }); }
          catch { r(); }
        })).catch(() => {});
      } finally {
        await nudge.close().catch(() => {});
      }
    } catch { /* the poll below is the real mechanism; the wake only hurries it */ }
  }

  while (!sw && Date.now() < deadline) {
    sw = ctx.serviceWorkers()[0] || null;
    if (!sw) await sleep(500);
  }

  if (!sw) {
    throw new Error(
      id
        ? `extension ${id} is installed but its service worker did not start within ${Math.round(timeoutMs / 1000)}s `
          + `(waking via chrome-extension://${id}/${wakePage} was ${wake ? 'attempted' : 'skipped'}). `
          + 'Check chrome://extensions for a load error, or the box for orphaned chrome.exe.'
        : `no chrome-extension:// origin appeared at all within ${Math.round(timeoutMs / 1000)}s — `
          + 'the unpacked extension failed to LOAD (not a worker-lifetime problem).'
    );
  }

  await sleep(settleMs);
  return sw;
}

export default awaitServiceWorker;
