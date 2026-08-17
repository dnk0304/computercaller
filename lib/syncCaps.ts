// Tiered sync row caps. The user picks a time range per category (messages /
// call logs) in the Full Sync panel; this maps that range to a hard ceiling on
// how many rows actually transfer. The preview count stays truthful — this cap
// only bounds what gets pulled, protecting against crash-risk on very large
// uncapped syncs (the reason caps were reintroduced after the v25 removal).
//
// Caps are enforced PER CATEGORY and independently: a 1-year sync pulls at most
// 10,000 messages AND at most 10,000 call logs, counted separately.
//
// This module is deliberately a pure range→cap map. There is NO subscription /
// tier resolution here — that logic was removed 2026-05-26 and is not coming
// back. If billing tiers ever gate caps, that belongs in a separate layer.

// Canonical sync time-range keys (locked 2026-05-27). "7 days" and "All time"
// were intentionally removed — these four are the only supported ranges.
// SyncSetupPanel imports this type so the UI options and the cap map can never
// drift apart.
// '3d' added 2026-08-17 (dispatch forge/pricing-trial-limited) for the limited
// free trial: the trial tier's syncRangeMax is '3d' (~last 3 days of history).
export type RangeKey = '3d' | '30d' | '3mo' | '6mo' | '1yr';

// Newest-N ceiling per range, applied separately to messages and to call logs.
// '3d' cap = 300: a 3-day window is small, but a very chatty line can still
// exceed a few hundred; 300 bounds the trial pull without truncating a normal
// user's recent history. Sized to sit well below the 30d cap.
export const RANGE_CAP: Record<RangeKey, number> = {
  '3d': 300,
  '30d': 1500,
  '3mo': 2500,
  '6mo': 5000,
  '1yr': 10000,
};

// Resolve the row cap for a range. Falls back to the smallest cap (1,500) for
// any unrecognized key so a mis-typed or transitional range can never produce
// an unbounded sync.
export function capForRange(range: RangeKey): number {
  return RANGE_CAP[range] ?? 1500;
}
