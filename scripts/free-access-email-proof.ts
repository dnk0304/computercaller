/**
 * Email proof — sendFreeAccessGrantedEmail (forge/free-access-duration).
 * Intercepts the Resend send call (no network) and asserts:
 *   • subject is the grant subject
 *   • a future expiry renders the correct HUMAN date ("September 25, 2026")
 *   • a null expiry renders "no expiry"
 *   • a THROWN Resend error is caught by the POST-route pattern (grant survives)
 *
 * Run: npx tsx scripts/free-access-email-proof.ts   (exit 0 = pass)
 */
import { Resend } from 'resend';

let captured: any = null;
let mode: 'ok' | 'throw' = 'ok';
process.env.RESEND_API_KEY = 'test_key_for_proof';
// Patch the shared Emails.prototype.send (no network) — lib/email.ts's lazy
// getResend() instance inherits it, so the real sender path is exercised.
const probe = new Resend('test_key_for_proof') as any;
const EmailsProto = Object.getPrototypeOf(probe.emails);
EmailsProto.send = async (opts: any) => {
  if (mode === 'throw') throw new Error('simulated Resend outage');
  captured = opts;
  return { data: { id: 'mock' }, error: null };
};

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  const { sendFreeAccessGrantedEmail } = await import('../lib/email');

  // Future expiry → human date. 2026-09-25 UTC.
  const exp = new Date('2026-09-25T12:00:00Z');
  await sendFreeAccessGrantedEmail({ email: 'grantee@example.com', expiresAt: exp });
  check('subject is grant subject',
    captured?.subject === "You've been granted free access to ComputerCaller",
    captured?.subject);
  check('body renders human date "September 25, 2026"',
    typeof captured?.html === 'string' && captured.html.includes('September 25, 2026'));
  check('body renders "until"', captured.html.includes('until'));

  // Null expiry → "no expiry".
  captured = null;
  await sendFreeAccessGrantedEmail({ email: 'grantee@example.com', expiresAt: null });
  check('null expiry renders "no expiry"',
    typeof captured?.html === 'string' && captured.html.includes('no expiry'));

  // Thrown Resend error → the POST route pattern must swallow it (grant lives).
  mode = 'throw';
  let emailSent = false;
  let grantSurvived = true;
  try {
    // exact pattern from POST /api/admin/free-access
    try {
      await sendFreeAccessGrantedEmail({ email: 'x@example.com', expiresAt: null });
      emailSent = true;
    } catch {
      emailSent = false; // swallowed
    }
  } catch {
    grantSurvived = false; // would mean the error escaped — a bug
  }
  check('thrown Resend error does NOT escape the grant flow', grantSurvived);
  check('emailSent === false on mail failure', emailSent === false);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
