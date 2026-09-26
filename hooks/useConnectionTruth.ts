'use client';

import { useEffect, useReducer, useSyncExternalStore } from 'react';

import { usePhone } from '@/hooks/PhoneProvider';
import { useAccountE2ePref } from '@/lib/e2eAccountPref';
import {
  connectionTruth,
  initialSwitchTrack,
  nextSwitchTrack,
  prefSignature,
  sameTrack,
  sasScreenApplies,
  SWITCH_MAX_MS,
  type ConnTruth,
  type SwitchInput,
  type SwitchTrack,
  type TruthView,
} from '@/lib/connectionTruth';
import { sasIsBlocking, type E2eStateName } from '@/lib/encryptedModeCopy';

/**
 * hooks/useConnectionTruth.ts — #18 CONN-STATUS. The selector every
 * connection-status surface reads (header chip, Encrypted-mode settings row,
 * the SAS dialog's gate). Decisions live in lib/connectionTruth.ts; this file
 * only feeds it the existing useE2e + usePhoneBridge + account-pref state.
 *
 * The tracker is ONE module-level value per page (one PhoneProvider per page),
 * so a surface that mounts late — the extension's account menu — reads the
 * same "Switching…" the header has been showing, instead of starting blind.
 *
 * Render is pure: it DERIVES `nextSwitchTrack(committed, input)` and renders
 * that; the effect commits it. The reducer is idempotent, so several consumers
 * committing the same input is a no-op after the first.
 */

let committed: SwitchTrack = initialSwitchTrack();
const listeners = new Set<() => void>();

function commit(next: SwitchTrack): void {
  if (sameTrack(committed, next)) return;
  committed = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const getSnapshot = () => committed;
/** Wall clock, read ONLY in effects/timers — never during render. */
const clock = (): number => Date.now();

const FALLBACK_VIEW: TruthView = {
  mode: 'off',
  effective: 'off',
  state: 'unencrypted',
  sas: { digits: null, confirmed: false },
};

interface PhoneSlice {
  e2e?: TruthView & { state: E2eStateName };
  lobbyState?: string;
}

export interface ConnectionTruthResult {
  /** `null` = not ours to say (no pair, or an e2e error the banner owns). */
  truth: ConnTruth | null;
  /** The SAS code screen may be shown (the pair it belongs to is current). */
  sasApplies: boolean;
}

export function useConnectionTruth(): ConnectionTruthResult {
  const phone = usePhone() as unknown as PhoneSlice;
  const account = useAccountE2ePref();
  const track = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const view = phone?.e2e ?? FALLBACK_VIEW;
  const pairActive = phone?.lobbyState === 'active';
  const input: SwitchInput = {
    prefSig: prefSignature(account.authoritative, account.mirror?.resolved),
    writePhase: account.phase,
    pairActive,
    view,
    // Render never reads the clock (react-hooks/purity). `now: 0` makes the
    // derived track time-blind — it can start or end a switch on an edge but
    // never expire one; expiry is the committed track's business, below.
    now: 0,
  };
  const derived = nextSwitchTrack(track, input);

  // Commit after every render: the reducer is idempotent and `commit` skips an
  // unchanged track, so this is cheap and cannot loop.
  useEffect(() => {
    commit(nextSwitchTrack(committed, { ...input, now: clock() }));
  });

  // "Switching…" must stop claiming itself after SWITCH_MAX_MS even if no
  // input changes (phone never comes back), so wake once at the deadline.
  // A re-render (not a commit from a stale closure) re-derives with fresh input.
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const deadline = track.switching ? track.since + SWITCH_MAX_MS + 50 : 0;
  useEffect(() => {
    if (!deadline) return;
    const t = setTimeout(wake, Math.max(0, deadline - clock()));
    return () => clearTimeout(t);
  }, [deadline]);

  const blocking = phone?.e2e ? sasIsBlocking(phone.e2e) : false;
  return {
    truth: connectionTruth(derived, view, pairActive),
    sasApplies: sasScreenApplies(derived, view, pairActive, blocking),
  };
}
