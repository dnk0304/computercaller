/**
 * passwordPolicy — the ONE definition of what makes a password acceptable.
 *
 * WHY THIS FILE EXISTS. The rules were literals inside
 * `app/api/auth/set-password/route.ts`. The set-password PAGE has to show the
 * reader those same rules while they type, and a UI "mirror" maintained by
 * copy-paste drifts the moment anything changes — the screen then promises one
 * thing and the server enforces another. So the numbers live here once and both
 * sides import them. Change the policy and the checklist changes with it.
 *
 * CLIENT-SAFE ON PURPOSE: no `db`, no `bcrypt`, no `process`, no node builtins.
 * A client component can import it without dragging the server into its bundle,
 * which is why the byte count below is measured with TextEncoder rather than
 * `Buffer.byteLength`.
 *
 * ⚠️ GUIDANCE, NEVER ENFORCEMENT. The route re-checks every rule on every write.
 * When the screen and the server ever disagree, the screen shows the SERVER's
 * verbatim message — it describes the rule that actually blocked the write.
 */

/** bcrypt SILENTLY TRUNCATES at 72 bytes; a longer password would mean its
 *  72-byte prefix is what authenticates. Rejected outright instead. */
export const MAX_PASSWORD_BYTES = 72;

export const MIN_PASSWORD = 8;

/** UTF-8 length without Buffer, so this module stays usable in the browser. */
export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

export type PasswordRule = {
  id: string;
  /** What to do, in the reader's language — not what went wrong. */
  label: string;
  satisfied: boolean;
};

/**
 * The checklist rendered under the password field. With an empty field every
 * rule reads as "not yet" rather than "failed", so nothing is announced as an
 * error before the reader has typed a single character.
 */
export function passwordRules(password: string): PasswordRule[] {
  const typed = password.length > 0;
  return [
    {
      id: 'length',
      label: `${MIN_PASSWORD} characters or more`,
      satisfied: password.length >= MIN_PASSWORD,
    },
    {
      id: 'bytes',
      label: `At most ${MAX_PASSWORD_BYTES} bytes — plain letters and digits always fit`,
      satisfied: typed && passwordByteLength(password) <= MAX_PASSWORD_BYTES,
    },
  ];
}
