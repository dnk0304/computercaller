/**
 * lib/e2ePref-core.js — the per-ACCOUNT Encrypted-mode setting (T-E2E-ACCOUNT-
 * PREF step 1, server side). DESIGN-E2E-ACCOUNT-PREF.md REV 2 §2-§8.
 *
 * ONE write path. The web page and the extension write over HTTP
 * (app/api/prefs/e2e), the phone writes over its already-authenticated relay
 * socket (SET_E2E_PREF / SEED_E2E_PREF in server.js), and both land in
 * setE2ePref / seedE2ePref below. Same resolution, same limiter, same log line.
 *
 * Plain CJS in lib/*-core.js for the reason every other *-core module is: the
 * relay is plain `node server.js` and cannot import TS. The Route Handlers
 * import it through lib/e2ePref.ts (typed by e2ePref-core.d.ts). Next bundles
 * its own copy of this module, so anything that must be SHARED between the two
 * callers at runtime (the rate limiter, the relay hooks) lives on globalThis,
 * never in module scope — the same single-process pattern as __resetRelayRoom.
 *
 * WHAT A WRITE DOES (§4, REV 2):
 *   - value equal to the current RESOLVED preference (including a null row that
 *     resolves to the default) -> no-op: no write, no rev bump, no push, no
 *     reset, changed:false. Nobody is kicked for re-confirming.
 *   - otherwise -> one conditional UPDATE (rev+1, server clock, updatedBy), then
 *     globalThis.__applyE2ePrefChange(userId): push E2E_PREF to every socket of
 *     the account, THEN force the lobby reset of both sides. "Changed" means
 *     the PREFERENCE changed; the reset fires even when the master switch is
 *     off and `effective` did not move ("you changed it, you reconnect").
 *   - SEED: compare-and-set on `e2ePref IS NULL`, 'on' only, bumps rev (Security
 *     M3: clients drop any rev they have already seen), pushes, never resets.
 *
 * FAILURE SHAPES (Security M2): the relay hook is checked BEFORE the write. If
 * it is missing (Route Handler served by a process that is not server.js) the
 * write is refused as a whole — never "saved but nobody kicked". If the hook
 * THROWS after the write, the error is surfaced (E2ePrefError 'reset_failed')
 * so the route answers 500, not 200.
 */

'use strict';

/** Stored in e2ePrefUpdatedBy. Anything else is refused, never stored. */
const E2E_PREF_SOURCES = Object.freeze(['web', 'ext', 'phone', 'seed', 'admin']);
const E2E_PREF_VALUES = Object.freeze(['on', 'off']);

/** Security m1: ONE limiter, keyed on userId, shared by HTTP and the relay. */
const E2E_PREF_LIMIT_PER_MIN = 10;
const E2E_PREF_LIMIT_PER_HOUR = 30;

/**
 * The master switch (E2E_PAIRING_ENABLED), NOT re-derived here. server.js
 * computes it once at boot (`const E2E_PAIRING_ENABLED = process.env.
 * E2E_PAIRING_ENABLED === '1'`, the predicate the kill-switch refusal uses) and
 * publishes that very boolean as globalThis.__e2ePairingEnabled. Anything but
 * `true` — including "not published" (no relay in this process) — reads as OFF.
 */
function isE2ePairingEnabled() {
  return globalThis.__e2ePairingEnabled === true;
}

/** Is the relay's master-switch value published in this process at all? */
function isMasterSwitchPublished() {
  return typeof globalThis.__e2ePairingEnabled === 'boolean';
}

/** §6: the default for accounts that never chose. Only the string 'on' is on. */
function isE2ePrefDefaultOn(env = process.env) {
  return env.E2E_PREF_DEFAULT === 'on';
}

/** Both env-derived inputs of resolveE2ePref, from one place. */
function e2ePrefEnv(env = process.env) {
  return { masterEnabled: isE2ePairingEnabled(), defaultOn: isE2ePrefDefaultOn(env) };
}

function toIso(d) {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/**
 * §3, pure. `row` is the User row's e2e columns (or null for "no row / never
 * chose"). Returns the resolved view every client renders from.
 *
 *   preference     = row.e2ePref ?? defaultOn
 *   effective      = preference AND masterEnabled  (the brake lowers, never raises)
 *   pausedByServer = preference on AND master off
 */
function resolveE2ePref(row, { masterEnabled, defaultOn }) {
  const stored = row && typeof row.e2ePref === 'boolean' ? row.e2ePref : null;
  const prefOn = stored === null ? defaultOn === true : stored;
  const effOn = prefOn && masterEnabled === true;
  return {
    preference: prefOn ? 'on' : 'off',
    effective: effOn ? 'on' : 'off',
    pausedByServer: prefOn && masterEnabled !== true,
    rev: row && Number.isInteger(row.e2ePrefRev) ? row.e2ePrefRev : 0,
    updatedAt: row ? toIso(row.e2ePrefUpdatedAt) : null,
    updatedBy: row && typeof row.e2ePrefUpdatedBy === 'string' ? row.e2ePrefUpdatedBy : null,
  };
}

/** Pure: would writing `value` change the resolved preference? (The SQL twin is SET_SQL's WHERE.) */
function decideSet(row, value, { defaultOn }) {
  const current = resolveE2ePref(row, { masterEnabled: false, defaultOn }).preference;
  return { changed: current !== value };
}

/** Pure: seed outcome. 'on' only; applies only while the row never chose. */
function decideSeed(row, value) {
  if (value !== 'on') return { refused: true, applied: false };
  const stored = row && typeof row.e2ePref === 'boolean' ? row.e2ePref : null;
  return { refused: false, applied: stored === null };
}

class E2ePrefError extends Error {
  /**
   * @param {'invalid_value'|'invalid_source'|'relay_unavailable'|'rate_limited'|'not_found'|'reset_failed'|'push_failed'} code
   */
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'E2ePrefError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Sliding-window limiter: <= perMin in any 60 s AND <= perHour in any 3600 s.
 * Every write ATTEMPT that passes validation counts (a no-op too) — the budget
 * is on how often an account can be asked to change, which is the abuse lever
 * (S5), not on how often it actually changed.
 */
function createE2ePrefLimiter(perMin = E2E_PREF_LIMIT_PER_MIN, perHour = E2E_PREF_LIMIT_PER_HOUR) {
  const hits = new Map(); // userId -> number[] (ms, ascending, last hour only)
  const HOUR = 3_600_000;
  const MIN = 60_000;
  return {
    take(userId, now = Date.now()) {
      const list = (hits.get(userId) || []).filter((t) => now - t < HOUR);
      const inMin = list.filter((t) => now - t < MIN);
      if (inMin.length >= perMin) {
        hits.set(userId, list);
        return { allowed: false, retryAfterMs: MIN - (now - inMin[0]) };
      }
      if (list.length >= perHour) {
        hits.set(userId, list);
        return { allowed: false, retryAfterMs: HOUR - (now - list[0]) };
      }
      list.push(now);
      hits.set(userId, list);
      return { allowed: true, retryAfterMs: 0 };
    },
    sweep(now = Date.now()) {
      for (const [u, list] of hits) {
        if (!list.length || now - list[list.length - 1] >= HOUR) hits.delete(u);
      }
    },
    size() { return hits.size; },
  };
}

/** The process-wide limiter. globalThis, because Next bundles its own copy of this module. */
function sharedE2ePrefLimiter() {
  if (!globalThis.__e2ePrefLimiter) globalThis.__e2ePrefLimiter = createE2ePrefLimiter();
  return globalThis.__e2ePrefLimiter;
}

/** Log-safe user id: never the raw id. */
function redactUserId(id) {
  if (typeof id !== 'string' || !id) return '<none>';
  return `${id.slice(0, 4)}…${id.length}`;
}

const COLS = `"e2ePref", "e2ePrefRev", "e2ePrefUpdatedAt", "e2ePrefUpdatedBy"`;

async function readRow(client, userId) {
  return client.user.findUnique({
    where: { id: userId },
    select: { e2ePref: true, e2ePrefRev: true, e2ePrefUpdatedAt: true, e2ePrefUpdatedBy: true },
  });
}

/** GET: the resolved view for one account, or null when the row is gone. */
async function getE2ePref(db, userId, env = process.env) {
  // Without the relay's published switch `effective` would be a guess, so the
  // read refuses exactly like the writes do (Security M2's "no silent" rule).
  if (!isMasterSwitchPublished()) throw new E2ePrefError('relay_unavailable', 'master switch not published in this process');
  const row = await readRow(db, userId);
  if (!row) return null;
  return resolveE2ePref(row, e2ePrefEnv(env));
}

function validate(value, source) {
  if (!E2E_PREF_VALUES.includes(value)) throw new E2ePrefError('invalid_value', 'value must be on|off');
  if (!E2E_PREF_SOURCES.includes(source)) throw new E2ePrefError('invalid_source', 'source not allowed');
}

function hook(opts, name) {
  const h = opts && opts.hooks ? opts.hooks[name] : globalThis[name];
  return typeof h === 'function' ? h : null;
}

function logWrite(userId, resolved, source, changed, log) {
  log(`[e2e-pref] user=${redactUserId(userId)} rev=${resolved.rev} value=${resolved.preference} by=${source} changed=${changed}`);
}

/**
 * Account write. One statement decides AND writes, so two concurrent writers
 * cannot both read a stale value and both "change" it into the same rev:
 * rev = rev + 1 is evaluated inside the UPDATE, and the no-op predicate is the
 * UPDATE's own WHERE (COALESCE(e2ePref, default) IS DISTINCT FROM value).
 *
 * @returns {Promise<{changed:boolean, resolved:object, reset:object|null}>}
 */
async function setE2ePref(db, userId, value, source, opts = {}) {
  validate(value, source);
  const env = opts.env || process.env;
  const log = opts.log || ((m) => console.log(m));
  const { masterEnabled, defaultOn } = e2ePrefEnv(env);

  // M2: refuse BEFORE writing if nobody can kick the sockets afterwards.
  const apply = hook(opts, '__applyE2ePrefChange');
  if (!apply) throw new E2ePrefError('relay_unavailable', 'relay hook __applyE2ePrefChange not installed');

  const limiter = opts.limiter || sharedE2ePrefLimiter();
  const gate = limiter.take(userId);
  if (!gate.allowed) throw new E2ePrefError('rate_limited', 'rate limited', { retryAfterMs: gate.retryAfterMs });

  const want = value === 'on';
  const { changed, row } = await db.$transaction(async (tx) => {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE "User"
          SET "e2ePref" = $1,
              "e2ePrefRev" = "e2ePrefRev" + 1,
              "e2ePrefUpdatedAt" = NOW(),
              "e2ePrefUpdatedBy" = $2,
              "updatedAt" = NOW()
        WHERE "id" = $3
          AND COALESCE("e2ePref", $4) IS DISTINCT FROM $1
      RETURNING ${COLS}`,
      want, source, userId, defaultOn,
    );
    if (updated.length === 1) return { changed: true, row: updated[0] };
    const current = await readRow(tx, userId);
    if (!current) throw new E2ePrefError('not_found', 'user not found');
    return { changed: false, row: current };
  });

  const resolved = resolveE2ePref(row, { masterEnabled, defaultOn });
  logWrite(userId, resolved, source, changed, log);
  if (!changed) return { changed: false, resolved, reset: null };

  let reset;
  try {
    reset = await apply(userId);
  } catch (e) {
    throw new E2ePrefError('reset_failed', `reset after e2e-pref write failed: ${e && e.message}`, { resolved, changed: true });
  }
  return { changed: true, resolved, reset: reset || null };
}

/**
 * Upgrade-only seeding (§7). 'on' only; applies only when e2ePref IS NULL, in
 * one conditional UPDATE (no read-then-write). Bumps rev, stores updatedBy
 * 'seed', pushes, NEVER resets.
 *
 * @returns {Promise<{applied:boolean, resolved:object}>}
 */
async function seedE2ePref(db, userId, value, source, opts = {}) {
  if (value !== 'on') throw new E2ePrefError('invalid_value', 'seed accepts only on');
  validate(value, source);
  const env = opts.env || process.env;
  const log = opts.log || ((m) => console.log(m));
  const pref = e2ePrefEnv(env);

  const push = hook(opts, '__pushE2ePref');
  if (!push) throw new E2ePrefError('relay_unavailable', 'relay hook __pushE2ePref not installed');

  const limiter = opts.limiter || sharedE2ePrefLimiter();
  const gate = limiter.take(userId);
  if (!gate.allowed) throw new E2ePrefError('rate_limited', 'rate limited', { retryAfterMs: gate.retryAfterMs });

  const { applied, row } = await db.$transaction(async (tx) => {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE "User"
          SET "e2ePref" = TRUE,
              "e2ePrefRev" = "e2ePrefRev" + 1,
              "e2ePrefUpdatedAt" = NOW(),
              "e2ePrefUpdatedBy" = 'seed',
              "updatedAt" = NOW()
        WHERE "id" = $1
          AND "e2ePref" IS NULL
      RETURNING ${COLS}`,
      userId,
    );
    if (updated.length === 1) return { applied: true, row: updated[0] };
    const current = await readRow(tx, userId);
    if (!current) throw new E2ePrefError('not_found', 'user not found');
    return { applied: false, row: current };
  });

  const resolved = resolveE2ePref(row, pref);
  log(`[e2e-pref] user=${redactUserId(userId)} rev=${resolved.rev} value=${resolved.preference} by=seed(${source}) changed=${applied}`);
  if (applied) {
    try {
      await push(userId);
    } catch (e) {
      throw new E2ePrefError('push_failed', `push after e2e-pref seed failed: ${e && e.message}`, { resolved, applied: true });
    }
  }
  return { applied, resolved };
}

/** The wire frame. One place builds it so every sender agrees on the shape. */
function e2ePrefFrame(resolved) {
  return `E2E_PREF:${JSON.stringify(resolved)}`;
}

module.exports = {
  E2E_PREF_SOURCES,
  E2E_PREF_VALUES,
  E2E_PREF_LIMIT_PER_MIN,
  E2E_PREF_LIMIT_PER_HOUR,
  E2ePrefError,
  isE2ePairingEnabled,
  isMasterSwitchPublished,
  isE2ePrefDefaultOn,
  e2ePrefEnv,
  resolveE2ePref,
  decideSet,
  decideSeed,
  createE2ePrefLimiter,
  sharedE2ePrefLimiter,
  redactUserId,
  getE2ePref,
  setE2ePref,
  seedE2ePref,
  e2ePrefFrame,
};
