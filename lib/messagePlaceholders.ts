// Explicit .ts extension so the runner-less node tests (native type
// stripping, no bundler) can resolve the runtime import — same reason
// tests/*.test.ts import with extensions. allowImportingTsExtensions is on.
import { conversationKey } from './normalizeNumber.ts';
import type { SmsMessage } from '@/hooks/phoneTypes';

/**
 * Placeholder-address detection + self-healing for live-pushed messages
 * (2026-06-12, "Unknown thread" bug).
 *
 * Repro: an SMS/MMS arriving while the phone is in an active call showed up
 * as a permanent "Unknown" thread; a manual Resync fetched it correctly.
 *
 * Root cause (Android live push path):
 *   - PhoneService.pushNewMmsEntries fires from the MMS ContentObserver the
 *     moment the messaging app inserts the pdu row — BEFORE the staged
 *     `addr` table write lands — so MmsHandler.getMmsAddress() returns null
 *     and the SMS_RECEIVED frame ships the literal fallback "Unknown"
 *     (MmsHandler.kt:71). The MMS watermark then advances past the row, so
 *     the now-complete row is never re-pushed.
 *   - SmsReceiver.kt has the same `originatingAddress ?: "Unknown"` fallback
 *     for the (rare) broadcast-without-address case.
 *
 * The sync path (MESSAGES_CHUNK) re-reads the provider when the row is
 * complete, so a full resync always shows the real sender — which is exactly
 * the observed "Resync fixes it" behavior.
 *
 * Web-side resilience (this module): a message whose address yields no
 * usable conversation key — or the literal "Unknown" placeholder — must not
 * become a permanent thread. The bridge (a) schedules a quiet merge refetch
 * when such a frame arrives, and (b) evicts placeholder rows once a
 * properly-addressed copy of the same message lands (live or via any sync).
 */

/**
 * Heal window: a placeholder row is considered the SAME logical message as a
 * properly-addressed row when direction + trimmed body match and the dates
 * are within this window. Wide because the two copies carry different
 * timestamps: the broadcast frame uses the SMSC timestamp while the provider
 * row uses device receive time (minutes of skew possible), and MMS dates
 * have second granularity. A genuine duplicate-body message from a DIFFERENT
 * sender inside the window would only evict a row that has no usable sender
 * anyway — low cost, and only the placeholder copy is ever dropped.
 */
export const PLACEHOLDER_HEAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when the address cannot identify a real conversation: empty/whitespace,
 * no usable key, or the Android-side literal "Unknown" fallback (any casing —
 * conversationKey lowercases alpha senders to '#unknown').
 */
export function isPlaceholderAddress(address: string | undefined | null): boolean {
  const key = conversationKey(address);
  return key === '' || key === '#unknown';
}

function healSig(m: SmsMessage): string {
  return `${m.type || ''}|${(m.body || '').trim()}`;
}

/**
 * Drop placeholder-addressed rows that have been "healed" by a properly-
 * addressed row carrying the same direction + trimmed body within
 * PLACEHOLDER_HEAL_WINDOW_MS. Returns the input array unchanged (same
 * reference) when there is nothing to do, so callers can cheaply run this on
 * every merge.
 *
 * Empty-body placeholders are never evicted — body equality is the identity
 * signal, and an empty string is too weak to claim two rows are the same
 * message.
 */
export function evictHealedPlaceholders(list: SmsMessage[]): SmsMessage[] {
  let placeholderIdx: number[] | null = null;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m && isPlaceholderAddress(m.address)) {
      (placeholderIdx ??= []).push(i);
    }
  }
  if (!placeholderIdx) return list;

  // Signature map of properly-addressed rows: `${type}|${body}` -> dates.
  const realSigs = new Map<string, number[]>();
  for (const m of list) {
    if (!m || isPlaceholderAddress(m.address)) continue;
    const sig = healSig(m);
    const dates = realSigs.get(sig);
    if (dates) dates.push(m.date || 0);
    else realSigs.set(sig, [m.date || 0]);
  }

  const drop = new Set<number>();
  for (const i of placeholderIdx) {
    const m = list[i];
    if (!m || !(m.body || '').trim()) continue; // empty body: identity too weak
    const dates = realSigs.get(healSig(m));
    if (dates && dates.some(d => Math.abs(d - (m.date || 0)) <= PLACEHOLDER_HEAL_WINDOW_MS)) {
      drop.add(i);
    }
  }
  if (drop.size === 0) return list;
  return list.filter((_, i) => !drop.has(i));
}
