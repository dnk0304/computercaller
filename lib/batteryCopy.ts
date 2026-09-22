/**
 * lib/batteryCopy.ts — BAT-3 (a)/(b). The battery indicator's DECISIONS, as
 * pure functions.
 *
 * Same reason lib/encryptedModeCopy.ts exists: every string and every threshold
 * the header renders is computed here so that scripts/bat-ui-proof.mjs can
 * import the SAME module the component imports. A harness that retypes
 * "Phone battery 47%, charging" proves the harness can type, not that the
 * product says it.
 *
 * DISPLAY-ONLY (GATE1 Addendum BAT-A1 MUST-3). Nothing in this file validates a
 * frame, writes storage, or touches mode / pairing / tier / quota / session. It
 * is given a value that BAT-2 already validated and returns text and tone. The
 * only guards here are null/undefined guards, which is exactly what the BAT-3
 * addendum permits and limits the UI to.
 */

/** The battery value as BAT-2 hands it over (hooks/phoneTypes.ts PhoneBattery). */
export interface BatteryValue {
  pct: number;
  charging: boolean;
  /** Epoch ms, stamped by the phone when it read the level. */
  ts: number;
}

/**
 * How old a reading may be before the tooltip starts saying WHEN it is from.
 *
 * 15 minutes, from PLAN.md. It is deliberately far above the phone's 10-minute
 * forced resend: a reading that is one missed resend old is normal traffic, not
 * staleness, so the qualifier only appears when the resend anchor itself has
 * stopped arriving. Exported because the harness asserts the boundary and must
 * not restate the number.
 */
export const BATTERY_STALE_MS = 15 * 60 * 1000;

/** `low` at <= 20 %, `critical` at <= 10 % (PLAN.md). */
export type BatteryTone = 'normal' | 'low' | 'critical';

export function batteryTone(pct: number): BatteryTone {
  if (pct <= 10) return 'critical';
  if (pct <= 20) return 'low';
  return 'normal';
}

/**
 * Local wall-clock for a reading, as "14:32".
 *
 * 24-hour and zero-padded rather than `toLocaleTimeString`: the string is
 * asserted by the harness and compared against screenshots, and a locale-
 * dependent rendering would make the proof pass or fail on the runner's ICU
 * data. The value is still LOCAL time — only the formatting is fixed.
 */
export function batteryClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** True when `ts` is older than the staleness window relative to `now`. */
export function isBatteryStale(ts: number, now: number): boolean {
  return now - ts > BATTERY_STALE_MS;
}

/**
 * The fill fraction of the glyph, 0..1.
 *
 * Clamped, and floored at a sliver so that 0 % and 1 % are still visibly a
 * battery with something in it rather than an empty rectangle indistinguishable
 * from "no reading". The numeric "%" beside it carries the exact value; the
 * glyph's job is the glance.
 */
export function batteryFill(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.max(0.06, clamped / 100);
}

/**
 * What the indicator SHOWS, as one decision.
 *
 * `null` means render nothing at all — not "--%", not a grey placeholder. A
 * placeholder for a value that has never existed is a lie the user cannot
 * distinguish from a phone at 0 %.
 */
export type BatteryView =
  | null
  | {
      /** `live` = phone present. `lastSeen` = phone gone, value retained. */
      kind: 'live' | 'lastSeen';
      pct: number;
      charging: boolean;
      tone: BatteryTone;
      /** Only ever true for `live` — a `lastSeen` value is stale by definition. */
      stale: boolean;
      /** "14:32" — the reading's own clock, present in both kinds. */
      clock: string;
      /** The short text beside the glyph. */
      text: string;
      /** The accessible name / tooltip. Read once; never announced live. */
      label: string;
    };

/**
 * The whole rendering decision for the indicator.
 *
 * @param battery the value BAT-2 validated, or null if nothing was ever received
 * @param present whether the phone is currently in the session
 * @param now     injected so the harness can pin staleness without faking clocks
 */
export function batteryView(
  battery: BatteryValue | null | undefined,
  present: boolean,
  now: number,
): BatteryView {
  // The ONE guard the UI is allowed (BAT-3 addendum): nothing received, nothing
  // rendered. Everything below this line has a real reading behind it.
  if (!battery) return null;

  const { pct, charging, ts } = battery;
  const tone = batteryTone(pct);
  const clock = batteryClock(ts);
  const charge = charging ? 'charging' : 'not charging';

  if (!present) {
    return {
      kind: 'lastSeen',
      pct,
      charging,
      tone,
      stale: false,
      clock,
      // "·" and not a hyphen: the two halves are peers (when, and what), not a
      // range. The separator is spaced so a screen reader does not run the
      // clock into the percentage.
      text: `Last seen ${clock} · ${pct}%`,
      label: `Phone battery ${pct}%, last seen ${clock}`,
    };
  }

  const stale = isBatteryStale(ts, now);
  return {
    kind: 'live',
    pct,
    charging,
    tone,
    stale,
    clock,
    text: `${pct}%`,
    // Battery moves slowly, so a stale reading is still worth showing — but the
    // tooltip has to admit WHEN it is from, or the header quietly asserts a
    // present-tense fact it cannot support.
    label: stale
      ? `Phone battery ${pct}%, ${charge}, as of ${clock}`
      : `Phone battery ${pct}%, ${charge}`,
  };
}

/**
 * Which of two readings to render when both a live hook value and a value
 * restored from the extension's storage.session are available.
 *
 * Newest `ts` wins, ties go to the first argument. This is the same ordering
 * rule reduceBattery() applies on the wire, for the same reason: a percentage
 * that jumps backwards is a bug the user sees. It is a CHOICE between two
 * already-validated values, never a merge — no field is taken from one and a
 * field from the other.
 */
export function newerBattery(
  a: BatteryValue | null | undefined,
  b: BatteryValue | null | undefined,
): BatteryValue | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.ts > a.ts ? b : a;
}
