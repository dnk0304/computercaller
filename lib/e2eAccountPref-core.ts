/**
 * lib/e2eAccountPref-core.ts — the per-ACCOUNT Encrypted-mode setting, client
 * side (T-E2E-ACCOUNT-PREF step 3; DESIGN REV 3 §3, §4, §7, §8, §12 M1).
 *
 * PURE. No React, no window, no fetch: every decision the website and the
 * extension make about the account value lives here so the node suite
 * (tests/e2e-account-pref-web.test.mjs) can drive it with real inputs. The
 * binder (lib/e2eAccountPref.ts) owns the storage handle, the socket and the
 * network; this file owns what they mean.
 *
 * ── WHAT THE SERVER SAYS, AND WHAT WE KEEP ─────────────────────────────────
 * The server resolves the row (lib/e2ePref-core.js resolveE2ePref) and sends
 * `{ preference, effective, pausedByServer, rev, updatedAt, updatedBy }` — on
 * GET, on every PUT/seed answer, and as the `E2E_PREF:{...}` relay push. The
 * client keeps a MIRROR of the last value it applied, keyed by userId (M1),
 * used only to paint and advertise before the first authoritative value of a
 * page load arrives. It is a cache, never a second source of truth: the web no
 * longer has a setting of its own.
 *
 * ── M1: KEYED BY userId, WIPED ON SIGN-OUT ─────────────────────────────────
 * The pre-M1 local switch was keyed by EMAIL (`cc:e2e:<email>`). The mirror is
 * keyed by the account's id, which an email change cannot move, and its `rev`
 * lives inside it — so account B can never inherit account A's last rev (which
 * would make every one of B's pushes look stale) or A's mode.
 */

export type E2ePrefValue = 'on' | 'off';

/** The resolved account value — the E2E_PREF frame body and every HTTP `resolved`. */
export interface ResolvedE2ePref {
  preference: E2ePrefValue;
  effective: E2ePrefValue;
  pausedByServer: boolean;
  rev: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A one-time "changed elsewhere" notice, persisted until the user dismisses it. */
export interface RemoteChangeNotice {
  value: E2ePrefValue;
  updatedBy: string | null;
  updatedAt: string | null;
  rev: number;
}

/** What the mirror stores for one account. */
export interface AccountPrefMirror {
  resolved: ResolvedE2ePref;
  notice: RemoteChangeNotice | null;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Enumerable storage, for the sign-in sweep of other accounts' mirrors. */
export type EnumerableStorage = StorageLike & Pick<Storage, 'key' | 'length'>;

// ── storage keys ─────────────────────────────────────────────────────────────

/** Prefix of every account mirror. Disjoint from the legacy email keys: an
 *  email always contains '@', and this segment never does. */
export const MIRROR_PREFIX = 'cc:e2e:acct:';

export function mirrorKey(userId: string): string {
  return `${MIRROR_PREFIX}${userId}`;
}

/**
 * The PRE-account local switch (P2, `hooks/phoneE2e.ts encryptedModeKey`).
 * Read exactly once more, for the upgrade-only seed (§7), then removed. The
 * format is duplicated here rather than imported so this module stays free of
 * the hook's import graph; tests pin the two against each other.
 */
export function legacyModeKey(email: string): string {
  return `cc:e2e:${email.toLowerCase()}`;
}

// ── validation ───────────────────────────────────────────────────────────────

const VALUES: readonly string[] = ['on', 'off'];

function isValue(v: unknown): v is E2ePrefValue {
  return typeof v === 'string' && VALUES.includes(v);
}

/**
 * Parse an untrusted resolved value (a relay frame, an HTTP body, a storage
 * read). Anything malformed is `null` — and a null is IGNORED by every caller,
 * never read as "off". A garbled frame must not be able to lower anything.
 */
export function parseResolved(raw: unknown): ResolvedE2ePref | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValue(r.preference) || !isValue(r.effective)) return null;
  if (typeof r.pausedByServer !== 'boolean') return null;
  if (typeof r.rev !== 'number' || !Number.isInteger(r.rev) || r.rev < 0) return null;
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt.length <= 64 ? r.updatedAt : null;
  const updatedBy = typeof r.updatedBy === 'string' && r.updatedBy.length <= 16 ? r.updatedBy : null;
  // The server's own invariant (§3): effective = preference AND master. An
  // effective ON under a preference OFF cannot come from resolveE2ePref.
  if (r.effective === 'on' && r.preference !== 'on') return null;
  return {
    preference: r.preference,
    effective: r.effective,
    pausedByServer: r.pausedByServer,
    rev: r.rev,
    updatedAt,
    updatedBy,
  };
}

function parseNotice(raw: unknown): RemoteChangeNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  if (!isValue(n.value) || typeof n.rev !== 'number' || !Number.isInteger(n.rev)) return null;
  return {
    value: n.value,
    rev: n.rev,
    updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : null,
    updatedBy: typeof n.updatedBy === 'string' ? n.updatedBy : null,
  };
}

// ── the mirror ───────────────────────────────────────────────────────────────

/** An unreadable store, an absent key and a garbage value are all `null`. */
export function readMirror(store: StorageLike | null, userId: string | null): AccountPrefMirror | null {
  if (!store || !userId) return null;
  try {
    const raw = store.getItem(mirrorKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { resolved?: unknown; notice?: unknown };
    const resolved = parseResolved(parsed?.resolved);
    if (!resolved) return null;
    return { resolved, notice: parseNotice(parsed?.notice) };
  } catch {
    return null;
  }
}

export function writeMirror(store: StorageLike | null, userId: string | null, mirror: AccountPrefMirror): void {
  if (!store || !userId) return;
  try {
    store.setItem(mirrorKey(userId), JSON.stringify(mirror));
  } catch {
    // A refused write costs only the pre-push paint on the next load.
  }
}

/** The legacy local switch, read for the seed. Same rule as P2: only 'on' is on. */
export function readLegacyMode(store: StorageLike | null, email: string | null): E2ePrefValue | null {
  if (!store || !email) return null;
  try {
    const v = store.getItem(legacyModeKey(email));
    if (v === null) return null;
    return v === 'on' ? 'on' : 'off';
  } catch {
    return null;
  }
}

export function removeLegacyMode(store: StorageLike | null, email: string | null): void {
  if (!store || !email) return;
  try { store.removeItem(legacyModeKey(email)); } catch { /* best-effort */ }
}

/**
 * M1, sign-out: the account's mirror (and its rev with it) and the legacy
 * switch both go. Nothing about this account's Encrypted mode survives in the
 * profile for the next person to sign in on it.
 */
export function wipeAccountPrefStorage(store: StorageLike | null, userId: string | null, email: string | null): void {
  if (!store) return;
  if (userId) {
    try { store.removeItem(mirrorKey(userId)); } catch { /* best-effort */ }
  }
  removeLegacyMode(store, email);
}

/**
 * M1, sign-in: remove every OTHER account's mirror. Belt to the sign-out
 * wipe's braces — a session that ended without our sign-out code running (the
 * shell's own probe finding the cookie gone, a crash, site data restored)
 * would otherwise leave that account's mirror behind. Keyed by userId it could
 * never be READ by another account, but "nothing carries over" is the rule and
 * this is how it holds even when a sign-out is missed.
 */
export function sweepOtherMirrors(store: EnumerableStorage | null, userId: string): number {
  if (!store) return 0;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(MIRROR_PREFIX) && k !== mirrorKey(userId)) doomed.push(k);
    }
  } catch {
    return 0;
  }
  for (const k of doomed) {
    try { store.removeItem(k); } catch { /* best-effort */ }
  }
  return doomed.length;
}

// ── applying a server value ──────────────────────────────────────────────────

export type IncomingSource = 'get' | 'push' | 'own-write';

export interface ApplyInput {
  current: AccountPrefMirror | null;
  incoming: ResolvedE2ePref;
  source: IncomingSource;
  /**
   * The value THIS device has just asked for and not yet heard back about.
   * Local knowledge, never the server's `updatedBy`: the push that announces
   * our own write usually arrives on the socket BEFORE the PUT's answer, and
   * without this it would be announced to the user as a change from elsewhere.
   */
  pendingOwnWrite: E2ePrefValue | null;
}

export type ApplyResult =
  | { applied: false; reason: 'stale' | 'duplicate' }
  | { applied: true; mirror: AccountPrefMirror; noticeRaised: boolean; masterOnly: boolean };

/**
 * One rule for GET, push and our own write's answer.
 *
 *   rev <  lastRev  -> dropped (stale: an older write overtaken in flight).
 *   rev == lastRev  -> dropped, EXCEPT the two master-switch fields (and only
 *                      when the preference itself is unchanged). The
 *                      server's master switch (E2E_PAIRING_ENABLED) is read at
 *                      relay boot and is NOT a write, so flipping it changes
 *                      `effective` / `pausedByServer` at the SAME rev. A strict
 *                      "rev <= last" drop would pin an account to its pre-flip
 *                      state until its next write — on a 0 -> 1 flip, "paused"
 *                      forever, advertising OFF. Only those two fields may
 *                      move; preference, updatedBy and updatedAt at an unchanged
 *                      rev are the server repeating itself and are ignored.
 *   rev >  lastRev  -> applied.
 *
 * The notice (§8, "shown once, both directions") is raised when an applied
 * value CHANGES the preference this device last knew, from somewhere that is
 * not this device: not our own write's answer, not the push matching our
 * pending write, not the silent seed (§7: migration never announces itself).
 * A first-ever value (no mirror) raises nothing — there is no "before".
 */
export function applyIncoming({ current, incoming, source, pendingOwnWrite }: ApplyInput): ApplyResult {
  if (current) {
    const last = current.resolved;
    if (incoming.rev < last.rev) return { applied: false, reason: 'stale' };
    if (incoming.rev === last.rev) {
      // Same rev, different preference: not something an honest server sends
      // (every preference change bumps rev). Nothing at this rev may move it.
      if (incoming.preference !== last.preference) return { applied: false, reason: 'duplicate' };
      if (incoming.effective === last.effective && incoming.pausedByServer === last.pausedByServer) {
        return { applied: false, reason: 'duplicate' };
      }
      // Only the master-switch fields move. effective is re-derived from the
      // pinned preference (§3: it can only be ON under preference ON).
      const effective: E2ePrefValue = last.preference === 'on' && incoming.effective === 'on' ? 'on' : 'off';
      return {
        applied: true,
        masterOnly: true,
        noticeRaised: false,
        mirror: {
          resolved: { ...last, effective, pausedByServer: last.preference === 'on' && effective === 'off' },
          notice: current.notice,
        },
      };
    }
  }

  const ours = source === 'own-write' || (pendingOwnWrite !== null && incoming.preference === pendingOwnWrite);
  const changed = current !== null && current.resolved.preference !== incoming.preference;
  const raise = changed && !ours && incoming.updatedBy !== 'seed';

  let notice = current?.notice ?? null;
  if (raise) {
    notice = { value: incoming.preference, updatedBy: incoming.updatedBy, updatedAt: incoming.updatedAt, rev: incoming.rev };
  } else if (ours) {
    // The user just made the change here; an older "changed elsewhere" line
    // is no longer the latest thing that happened to this setting.
    notice = null;
  }
  return { applied: true, masterOnly: false, noticeRaised: raise, mirror: { resolved: incoming, notice } };
}

// ── what the page advertises ─────────────────────────────────────────────────

/**
 * The mode this computer puts in its pairing e2e block (§3: clients advertise
 * `effective`; the OR rule and the Accept latch are untouched downstream).
 *
 * Before the first authoritative value of this page load (GET answer or push),
 * the mirror is advertised and nothing may lower it — the M1 "never lower
 * before the first push" rule. There is no local default that could: with no
 * mirror the answer is OFF, which IS the account default (§6, LOCKED off).
 */
export function advertisedMode(mirror: AccountPrefMirror | null): E2ePrefValue {
  return mirror?.resolved.effective === 'on' ? 'on' : 'off';
}

// ── seed once (§7) ───────────────────────────────────────────────────────────

/**
 * "Server value is null" = a row that never chose: rev 0 and no author. Every
 * accepted write — the seed included (Security M3) — bumps rev, so rev 0 is
 * exactly "nobody has ever written this".
 */
export function serverNeverChose(r: ResolvedE2ePref): boolean {
  return r.rev === 0 && r.updatedBy === null;
}

/** Upgrade-only: seed ON when the account never chose and this device's old switch was ON. Local OFF never seeds. */
export function shouldSeed(server: ResolvedE2ePref, legacy: E2ePrefValue | null): boolean {
  return serverNeverChose(server) && legacy === 'on';
}

/**
 * After a seed attempt, is the legacy switch done with? Yes once the server
 * has answered at all (applied, or refused because the account already chose)
 * — it is never consulted again. A transport failure (429 / 5xx / offline)
 * keeps it, so the migration is retried on the next load instead of being lost.
 */
export function legacyConsumed(outcome: WriteOutcome): boolean {
  return outcome.kind === 'saved';
}

/** Legacy key with nothing to seed (OFF, or the account already chose) is simply retired. */
export function legacyRetiredWithoutSeed(server: ResolvedE2ePref, legacy: E2ePrefValue | null): boolean {
  return legacy !== null && !shouldSeed(server, legacy);
}

// ── HTTP answers (§8 + step-1 status map) ────────────────────────────────────

export type WriteOutcome =
  | { kind: 'saved'; changed: boolean; resolved: ResolvedE2ePref | null; resetClosed: number }
  | { kind: 'rate-limited' }
  | { kind: 'failed'; status: number };

/**
 * PUT /api/prefs/e2e and POST /api/prefs/e2e/seed share one status map:
 *   200       saved (changed may be false: re-confirming the current value is
 *             a no-op and kicks nobody)
 *   429       nothing saved
 *   503 / 500 `reset:null` — could not apply; the caller re-reads the server
 *             value, because a 500 may have saved without resetting (M2)
 *   anything else, and a transport failure (status 0), is a failure too.
 */
export function classifyWriteResponse(status: number, body: unknown): WriteOutcome {
  if (status === 200 && body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const resolved = parseResolved(b.resolved);
    const changed = b.changed === true || b.applied === true;
    const reset = b.reset && typeof b.reset === 'object' ? (b.reset as Record<string, unknown>) : null;
    const closed = reset && typeof reset.closed === 'number' ? reset.closed : 0;
    return { kind: 'saved', changed, resolved, resetClosed: closed };
  }
  if (status === 429) return { kind: 'rate-limited' };
  return { kind: 'failed', status };
}

// ── copy ─────────────────────────────────────────────────────────────────────
// Exact strings from DESIGN §8 and the step-3 brief. Exported so the tests and
// the Playwright proof assert the SAME constants the UI renders.

export const CONFIRM_TITLE: Record<E2ePrefValue, string> = {
  on: 'Turn on Encrypted mode?',
  off: 'Turn off Encrypted mode?',
};
export const CONFIRM_BODY: Record<E2ePrefValue, string> = {
  on: 'Your phone and computer will disconnect. Connect again and check the code on both screens.',
  off: 'Your phone and computer will disconnect. Next time you connect there is no code check.',
};
export const CONFIRM_ACTION: Record<E2ePrefValue, string> = { on: 'Turn on', off: 'Turn off' };
export const CONFIRM_CANCEL = 'Cancel';

export const STATE_LABEL_ON = 'On';
export const STATE_LABEL_OFF = 'Off';
export const STATE_LABEL_PAUSED = 'On, paused by ComputerCaller';
export const STATE_LABEL_LOADING = 'Checking your account';

export const RATE_LIMITED_COPY = 'Too many changes, try again in a minute';
export const COULD_NOT_APPLY_COPY = 'Could not apply, try again';
export const SAVING_COPY = 'Saving';

export function reconnectingCopy(value: E2ePrefValue): string {
  return value === 'on' ? 'Reconnecting in Encrypted mode…' : 'Reconnecting with Encrypted mode off…';
}

/** The account state line. Paused is never shown as a plain Off (§3). */
export function stateLabel(r: ResolvedE2ePref | null): string {
  if (!r) return STATE_LABEL_LOADING;
  if (r.pausedByServer) return STATE_LABEL_PAUSED;
  return r.preference === 'on' ? STATE_LABEL_ON : STATE_LABEL_OFF;
}

/** `updatedBy` in words. Unknown authors are not guessed at. */
export function deviceLabel(updatedBy: string | null): string | null {
  switch (updatedBy) {
    case 'phone': return 'your phone';
    case 'web': return 'the website';
    case 'ext': return 'the Chrome extension';
    case 'admin': return 'ComputerCaller support';
    default: return null;
  }
}

/**
 * "14:32" today, "24 Sep, 14:32" otherwise. `locale` and `timeZone` are
 * injectable so the node suite is deterministic; the UI passes neither.
 */
export function formatChangeTime(iso: string | null, now: Date, locale?: string, timeZone?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opt: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
  const day = (x: Date) => new Intl.DateTimeFormat(locale ?? 'en-CA', { ...opt, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat(locale, { ...opt, hour: '2-digit', minute: '2-digit' }).format(d);
  if (day(d) === day(now)) return time;
  const date = new Intl.DateTimeFormat(locale, { ...opt, day: 'numeric', month: 'short' }).format(d);
  return `${date}, ${time}`;
}

/** "Changed from your phone at 14:32". null when the server has no author or time. */
export function changedFromLine(r: ResolvedE2ePref | null, now: Date, locale?: string, timeZone?: string): string | null {
  if (!r) return null;
  const at = formatChangeTime(r.updatedAt, now, locale, timeZone);
  if (!at) return null;
  if (r.updatedBy === 'seed') return `Carried over from your earlier setting at ${at}`;
  const who = deviceLabel(r.updatedBy);
  return who ? `Changed from ${who} at ${at}` : null;
}

/** "Encrypted mode was turned off from your phone at 14:32". */
export function remoteNoticeCopy(n: RemoteChangeNotice, now: Date, locale?: string, timeZone?: string): string {
  const who = deviceLabel(n.updatedBy) ?? 'another device';
  const at = formatChangeTime(n.updatedAt, now, locale, timeZone);
  return `Encrypted mode was turned ${n.value} from ${who}${at ? ` at ${at}` : ''}`;
}
