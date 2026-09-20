/**
 * lib/e2e/signOutEverywhere.ts — the ORDER of a revoking teardown
 * (E2E-P2.3 (a) + (b), GATE1 Addendum A5 F1 / MUST M-A5-1 (a)).
 *
 * ── WHY THE ORDER IS THE DELIVERABLE ───────────────────────────────────────
 * M-A5-1 (a) says the revoking side tears itself down, and names the leg that
 * matters: the LOCAL one, "because it is the only leg that works against a peer
 * that has stopped polling, and it is entirely local state — no relay trust".
 * Everything after the local drop is a courtesy to a network that may not be
 * there. So the order is not a style choice, it is the security property:
 *
 *   1. `revokeLocalPair(reason)`  — the SK and its seq records go. FAIL-CLOSED:
 *      if this throws we still continue, because continuing can only remove
 *      more access, never restore any.
 *   2. `resetRoom()`              — empty the relay room so the pair does not
 *      outlive the act. BEST-EFFORT: a failure here leaves a room, not a key.
 *   3. `onSignOut()`              — hook state. Sign-out only; a "forget this
 *      computer" keeps the user signed in and passes `signOut: false`.
 *   4. `revokeRemote()`           — the caller's own DeviceKey row. BEST-EFFORT
 *      and LAST of the teardown, but still BEFORE the logout fetch, because it
 *      needs the session cookie that logout is about to destroy.
 *
 * ── WHAT "NOTHING BLOCKS THE LOGOUT" MEANS HERE ────────────────────────────
 * {@link runRevokingTeardown} never rejects. Every leg is independently
 * guarded, and a leg that throws is recorded in the trace and stepped over.
 * A caller writes `await runRevokingTeardown(...)` and then its logout fetch,
 * with no try/catch of its own and no way to be stranded — which is exactly why
 * the four `/api/auth/logout` callers can share one helper instead of each
 * re-implementing four legs and four catch blocks.
 *
 * This file is pure and React-free on purpose: the order above is the thing
 * that must be provable in the node suite, and hooks/usePhoneBridge.ts is not
 * importable from one. The hook is the binder; this is the decision.
 */

// Explicit .ts extensions throughout lib/e2e: these modules are imported by
// the node suites under type-stripping, which does NOT do extensionless
// resolution. The repo already spells it this way (see usePhoneBridge's
// '@/lib/fileTransfer/frames.ts').
import { revokeOwnWebDeviceKey, type RevokeOwnKeyResult } from './revokeWebKey.ts';

/** The legs, in the order {@link runRevokingTeardown} runs them. */
export const TEARDOWN_STEPS = ['revokeLocalPair', 'resetRoom', 'onSignOut', 'revokeRemote'] as const;
export type TeardownStep = (typeof TEARDOWN_STEPS)[number];

export interface RevokingTeardownDeps {
  /** M-A5-1 (a) local leg. Resolves true when the caller should RESET_ROOM. */
  revokeLocalPair(reason: string): Promise<boolean> | boolean;
  /** usePhoneBridge's existing "Reset lobby" transport reset. */
  resetRoom(): Promise<void> | void;
  /** The hook's sign-out state wipe. Skipped when `signOut` is false. */
  onSignOut(): void;
  /** Defaults to {@link revokeOwnWebDeviceKey}; injected by the node suite. */
  revokeRemote?(): Promise<RevokeOwnKeyResult>;
  /** Defaults to `console.warn`. */
  warn?(message: string, err?: unknown): void;
}

export interface RevokingTeardownOptions {
  /**
   * Why the pair is being torn down. Reaches `revokeLocalPair` verbatim and
   * ends up in the hook's error detail, so it is the breadcrumb a support
   * session reads: 'sign-out' or 'user-forget'.
   */
  reason: string;
  /**
   * True for a sign-out (step 3 runs), false for "Forget this computer" — the
   * user stays signed in, so wiping the hook's sign-out state would be a lie
   * about the session.
   */
  signOut: boolean;
}

export interface TeardownTrace {
  /** The steps that were attempted, in order. The ORDER assertion reads this. */
  ran: TeardownStep[];
  /** The steps that threw or resolved unsuccessfully. Never fatal. */
  failed: TeardownStep[];
  /** Whatever the remote leg reported. null when it was not reached. */
  remote: RevokeOwnKeyResult | null;
}

/**
 * Run the revoking teardown. ALWAYS resolves — see the header.
 *
 * @returns the trace, so a caller (and the node suite) can see exactly which
 *          legs ran and which were stepped over.
 */
export async function runRevokingTeardown(
  deps: RevokingTeardownDeps,
  { reason, signOut }: RevokingTeardownOptions,
): Promise<TeardownTrace> {
  const trace: TeardownTrace = { ran: [], failed: [], remote: null };
  const warn = deps.warn ?? ((m: string, e?: unknown) => console.warn(m, e));

  // 1. LOCAL, first, always. The SK is gone after this line whatever else
  //    happens, and that is the whole of M-A5-1 (a)'s independence claim.
  trace.ran.push('revokeLocalPair');
  try {
    await deps.revokeLocalPair(reason);
  } catch (e) {
    trace.failed.push('revokeLocalPair');
    warn(`[E2E] revokeLocalPair(${reason}) failed; continuing teardown`, e);
  }

  // 2. Transport. A room that outlives the revoke is noise, not access — the
  //    peer can no longer open anything this browser seals.
  trace.ran.push('resetRoom');
  try {
    await deps.resetRoom();
  } catch (e) {
    trace.failed.push('resetRoom');
    warn('[E2E] resetRoom failed during teardown; continuing', e);
  }

  // 3. Hook state — sign-out only.
  if (signOut) {
    trace.ran.push('onSignOut');
    try {
      deps.onSignOut();
    } catch (e) {
      trace.failed.push('onSignOut');
      warn('[E2E] onSignOut failed during teardown; continuing', e);
    }
  }

  // 4. Remote, last, and still ahead of the caller's logout fetch: the route
  //    authenticates with the session cookie that logout is about to clear.
  trace.ran.push('revokeRemote');
  try {
    const remote = await (deps.revokeRemote ?? revokeOwnWebDeviceKey)();
    trace.remote = remote;
    if (!remote.ok) {
      trace.failed.push('revokeRemote');
      warn(`[E2E] server-side device key revoke not completed (${remote.reason ?? 'unknown'})`);
    }
  } catch (e) {
    trace.failed.push('revokeRemote');
    warn('[E2E] server-side device key revoke threw; continuing', e);
  }

  return trace;
}
