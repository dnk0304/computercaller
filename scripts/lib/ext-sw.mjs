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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The ID Chrome assigns an unpacked extension: SHA-256 of the absolute path,
 * first 16 bytes, each nibble mapped 0-f → a-p. Deterministic, so it is a
 * usable last resort when no worker and no page has surfaced the ID yet.
 * Chrome hashes the path in the platform's native encoding — UTF-16LE on
 * Windows, UTF-8 elsewhere.
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
  try {
    const probe = await ctx.newPage();
    try {
      await probe.goto('chrome://extensions-internals', { timeout: 10_000 });
      const raw = await probe.evaluate(() => document.body.innerText);
      const parsed = JSON.parse(raw);
      const hit = (Array.isArray(parsed) ? parsed : []).find((e) => /^[a-p]{32}$/.test(e?.id || ''));
      if (hit) return hit.id;
    } finally {
      await probe.close().catch(() => {});
    }
  } catch { /* fall through to the computed ID */ }

  return extDir ? unpackedExtensionId(extDir) : null;
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
