import type { Contact } from '@/hooks/phoneTypes';

/**
 * Normalise a phone number to digits-only, optionally preserving a leading '+'.
 *
 * Goal: the same physical person should produce the same suffix regardless of
 * format. Phones may send "+47 12 34 56 78"; contacts may be stored as
 * "12 34 56 78" or "004712345678" or "(415) 555-1212". We strip every
 * non-digit, preserving the leading '+' as a marker for international form.
 *
 * Used together with `findContactByNumber` below, which does a digit-suffix
 * match — so even when country-code prefixes differ ('+47…' vs '0047…' vs
 * the plain national number), the same contact still resolves.
 */
export function normalizeNumber(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Match a phone number against the contacts list using a digit-suffix heuristic
 * tolerant of country-code / formatting differences. Returns the first matching
 * Contact or undefined.
 *
 * Heuristic: compare the last min(a.length, target.length, 7) digits — 7 is the
 * standard "same person" threshold and covers:
 *   "+1 415 555 1212"  vs  "415-555-1212"  vs  "5551212"
 *   "+47 12 34 56 78"  vs  "12 34 56 78"
 * It deliberately ignores the country-code prefix because the phone-side
 * resolver and the contacts table often disagree on whether to include it.
 */
export function findContactByNumber(
  number: string | undefined | null,
  contacts: ReadonlyArray<Contact>,
): Contact | undefined {
  const target = normalizeNumber(number).replace(/^\+/, '');
  if (!target) return undefined;
  return contacts.find((c) => {
    const a = normalizeNumber(c.number).replace(/^\+/, '');
    if (!a) return false;
    const min = Math.min(a.length, target.length, 7);
    return a.slice(-min) === target.slice(-min);
  });
}
