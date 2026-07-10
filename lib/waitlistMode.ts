/**
 * Waitlist-mode flag — the single reversible switch for the pre-launch landing.
 *
 * When ON (env `NEXT_PUBLIC_WAITLIST_MODE` set truthy):
 *   • Every public "Start free trial" / "Sign in" / "Register" CTA on the
 *     marketing pages (/) is replaced with a "Join waitlist" email
 *     capture, OR hidden. NO path to /auth/* or Whop checkout exists publicly.
 *
 * When OFF (env unset or falsy):
 *   • The pages render their ORIGINAL trial/sign-in/payment UI, byte-for-byte.
 *     Flipping this flag restores the paid site with zero code changes.
 *
 * Because the value is a `NEXT_PUBLIC_*` env var, Next inlines it at BUILD time
 * — both server and client see the same constant, so there is no hydration
 * mismatch from reading it during render.
 *
 * Code default is OFF (unset → original site) so reversibility is guaranteed by
 * construction. The deployment ships `.env` with the flag set to `true` so the
 * live default is ON until launch; remove/flip that one line to go back.
 */
export const WAITLIST_MODE: boolean = ['true', '1', 'on', 'yes'].includes(
  (process.env.NEXT_PUBLIC_WAITLIST_MODE ?? '').trim().toLowerCase(),
);
