import type { Contact } from '@/hooks/phoneTypes';

/**
 * Canonical key used to decide whether two address strings represent the
 * SAME conversation. This is the single source of truth for matching across
 * the web layer (threadMessages filter, thread-list isSelected, SMS_RECEIVED
 * dedupe). Every call site MUST use this — not a hand-rolled tail compare.
 *
 * Rules (chosen so two distinct people can never collide, including the
 * short-code / service-sender case that was bleeding chats together):
 *  - Empty / nullish → ''.
 *  - Address with NO digits (alphanumeric service ID like "Google", "PayPal",
 *    "Cube") → lowercased, trimmed exact string. These match only themselves.
 *  - Address WITH digits:
 *      * If total digits ≥ 7 (a real phone number — international,
 *        national, or local format), the key is "p:" + last 7 digits.
 *        Last-7 is the "same subscriber" threshold already used by
 *        findContactByNumber below; it absorbs country-code prefix
 *        variation ("+4745720075" / "4745720075" / "45720075" all collapse
 *        to p:5720075) while two genuinely-distinct subscribers virtually
 *        never share their last 7 digits.
 *      * If total digits < 7 (short code like "2226" or "22 26", or a
 *        truncated stored address), the key is "s:" + the full digit string.
 *        Short codes match ONLY the exact same short code — a 4-digit
 *        short code "2226" can never match a real phone whose tail
 *        happens to be "...2226" because the namespace prefix differs
 *        ('s:' vs 'p:').
 *
 * Prefixes ('p:' / 's:' / a leading '#' for alpha) keep the three namespaces
 * disjoint so cross-namespace collisions are impossible by construction.
 * This is what closed the chat-mixing bug (2026-06-03) where the previous
 * Math.min(len, 10) digit-tail collapsed to as few as 4 digits AND ignored
 * the short-code vs phone distinction, causing two unrelated senders to
 * resolve to the same thread.
 */
export function conversationKey(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return `#${trimmed.toLowerCase()}`;
  if (digits.length >= 7) return `p:${digits.slice(-7)}`;
  return `s:${digits}`;
}

/**
 * True iff `a` and `b` belong to the same conversation per `conversationKey`.
 * Use this everywhere instead of ad-hoc digit-tail compares.
 */
export function sameConversation(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const ka = conversationKey(a);
  const kb = conversationKey(b);
  return ka !== '' && ka === kb;
}

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
 * Match a phone number against the contacts list. Returns the first matching
 * Contact or undefined.
 *
 * Rules (Issue 2 fix, 2026-06-11 — the "spelinfo" bug):
 *   1. Both sides have ≥ 7 digits (real phone numbers) → match on the last 7
 *      digits. Absorbs country-code / formatting variation:
 *        "+1 415 555 1212"  vs  "415-555-1212"  vs  "5551212"
 *        "+47 12 34 56 78"  vs  "12 34 56 78"
 *   2. Either side has < 7 digits (short code / service number) → match ONLY
 *      on full exact digit-string equality. Never partial / suffix. The old
 *      `min(a.len, target.len, 7)` suffix compare let a stored 4-digit
 *      shortcode (e.g. "2226") claim ANY real caller whose number happened to
 *      end in those digits, mislabeling live calls with the shortcode's name.
 *   3. No digits on either side → no match.
 *
 * Implemented via `conversationKey` — the same namespaced key (`p:` last-7 vs
 * `s:` full shortcode) that closed the 2026-06-03 chat-mixing bug — so contact
 * matching and thread matching can never disagree. Equivalence verified:
 * `normalizeNumber(x).replace(/^\+/, '')` and conversationKey's
 * `replace(/\D/g, '')` produce the same digit string ('+' is a non-digit),
 * and both inputs are guarded non-empty-digits, so keys are always `p:`/`s:`
 * forms whose equality is exactly rules 1–2.
 */
export function findContactByNumber(
  number: string | undefined | null,
  contacts: ReadonlyArray<Contact>,
): Contact | undefined {
  const target = normalizeNumber(number).replace(/^\+/, '');
  if (!target) return undefined; // rule 3: no digits → no match
  const targetKey = conversationKey(number);
  return contacts.find((c) => {
    const a = normalizeNumber(c.number).replace(/^\+/, '');
    if (!a) return false; // rule 3: stored entry without digits never matches
    return conversationKey(c.number) === targetKey;
  });
}
