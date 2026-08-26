/**
 * POST /api/admin/users — admin-provisioned account creation
 * (dispatch forge/admin-create-account, 2026-08-15).
 *
 * Dennis: "a section in the admin panel where I can create accounts myself."
 *
 * WHAT THIS IS
 * ------------
 * Self-serve signup is Google-only and card-first: /api/auth/register is 410
 * Gone, and the Google callback deliberately creates NO Subscription row, so a
 * fresh user lands on /subscribe. That is correct for the public, and useless
 * for "I want to hand this specific person an account". Until now the admin
 * panel had NO user-mutation path at all — the only way to make an account was
 * to be that person and click Google, or to hand-write SQL.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 *  • It NEVER writes a fake/comped Subscription row. Free access has ONE
 *    sanctioned mechanism — FreeAccessEmail + FreeAccessAudit — which the
 *    shared entitlement core already admits (rule 2b) and resolveTier already
 *    maps to the top tier. Faking a subscription would invent a fourth admit
 *    path and corrupt every revenue figure the admin panel reports.
 *  • It adds no new entitlement logic whatsoever. Comping goes through
 *    lib/freeAccessGrant.grantFreeAccess — the SAME function
 *    POST /api/admin/free-access calls. Duplicating that logic is precisely
 *    what caused the 2026-08-12 proxy.ts drift bug.
 *  • The admin never invents, sees, transports or handles a password. The
 *    account is created with `passwordHash: null` and a single-use, expiring,
 *    hashed-at-rest invite token (lib/passwordSetToken); the invitee chooses
 *    their own credential at POST /api/auth/set-password.
 *
 * SECURITY
 * --------
 * Same gate as /api/admin/free-access, via the now-shared helpers:
 * requireSameOrigin (CSRF) → requireAdmin (401/403, fail-closed). Every
 * creation writes an append-only AdminUserAudit row: an admin minting accounts
 * must leave a durable who/when/what trail.
 *
 * ── CONTRACT ────────────────────────────────────────────────────────────────
 * Request  { email: string, name?: string, freeAccess?: boolean, note?: string }
 *          { email: string, resend: true, note?: string }   ← re-invite path
 *
 * 200 { user, invite, resent: true }   RESEND only. A fresh one-time link for an
 *     existing, un-redeemed, admin-invited account; the previous link is dead.
 *     Refused (409 already_redeemed / not_resendable) for an account that has a
 *     password or signs in with Google — see the RESEND note below.
 * 404 { error, code: 'user_not_found' }  RESEND only: nothing to re-invite.
 *
 * 201 { user: { id, email, name, freeAccess, createdAt },
 *       invite: { url, expiresAt, emailSent, emailError } }
 *     `invite.url` is the ONE-TIME link; it is returned so the admin can hand it
 *     over manually. It is shown once and is unrecoverable afterwards (only its
 *     hash is stored) — re-inviting mints a new one.
 *     `emailSent:false` + `emailError` = the account EXISTS, the mail failed;
 *     the UI must tell the admin to copy the link. Never a rollback.
 * 400 { error }                        malformed JSON / invalid email
 * 403 { error: 'CSRF check failed' } | { error: 'Forbidden' }
 * 401 { error: 'Not authenticated' }
 * 409 { error, code: 'user_exists', user: { id, email, createdAt, authProvider,
 *       hasPassword, freeAccess } }
 *     An existing account is NEVER silently mutated. The admin sees its real
 *     state and decides.
 * 500 { error }
 * ────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireSameOrigin } from '@/lib/auth';
import { db } from '@/lib/db';
import { getClientIp } from '@/lib/ip';
import { requireAdmin, parseJsonBody } from '@/lib/adminGate';
import { grantFreeAccess, normalizeEmail, normalizeNote } from '@/lib/freeAccessGrant';
import {
  mintPasswordSetToken,
  buildSetPasswordUrl,
  INVITE_TTL_MS,
} from '@/lib/passwordSetToken';
import { sendAdminInviteEmail } from '@/lib/email';
import { resendRefusal, RESEND_REFUSAL_MESSAGE } from '@/lib/inviteResend-core';

/**
 * ── RESEND ──────────────────────────────────────────────────────────────────
 * Added 2026-08-15 (dispatch pixel/invite-resend) because the panel had a
 * genuine dead end: the one-time invite URL is shown once and only its SHA-256
 * is stored, so a lost link permanently burned the account — the 409 above is
 * the ONLY thing a re-submit could produce, and the UI's "create the invite
 * again" advice was therefore impossible to follow.
 *
 * `{ email, resend: true }` mints a FRESH token for an existing account and
 * revokes the previous one (one token column, overwritten).
 *
 * ⛔ WHAT IT REFUSES, AND WHY. This is deliberately NOT a password reset. A
 * set-password token is a credential-bearing capability for whoever holds the
 * link, so it may only ever be issued for an account that has no credential to
 * take over:
 *
 *   passwordHash !== null   → 409 already_redeemed. The invitee has set their
 *                             password. Re-inviting would be an admin-triggered
 *                             credential RESET of a live account — a different
 *                             act, with different consent and audit needs.
 *   authProvider !== 'email'→ 409 not_resendable. A Google account has
 *                             passwordHash null but IS already controlled by a
 *                             real person; minting a set-password link for it
 *                             would let the link-holder add a password
 *                             credential to someone else's live account.
 *
 * Both checks are re-asserted INSIDE the transaction as a conditional
 * updateMany, so a redemption racing this request cannot slip through the
 * read-then-write window.
 *
 * Free access is never touched on a resend: re-sending a link is not a
 * re-grant, and `body.freeAccess` is ignored on this path entirely.
 */

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return NextResponse.json({ error: 'CSRF check failed' }, { status: 403 });

    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.res;

    const body = await parseJsonBody(req);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

    const email = normalizeEmail(body.email);
    if (!email) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
    }
    const name = normalizeNote(body.name, 120);
    const note = normalizeNote(body.note);
    const freeAccess = body.freeAccess === true;

    // Resend is an explicit, separate verb on the same route — it shares the
    // exact requireSameOrigin + requireAdmin gate above and adds no auth path.
    if (body.resend === true) return await resendInvite(email, note, gate.adminEmail);

    // ── Idempotent-SAFE, not idempotent ─────────────────────────────────────
    // Re-POSTing an existing email must NOT quietly re-mint a token, reset a
    // password, or flip someone's free-access. Report the account's real state
    // and let the admin choose. (This is a pre-check for a good error message;
    // the unique constraint on User.email is the actual guarantee — see the
    // P2002 catch below, which closes the race between these two statements.)
    const existing = await db.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        createdAt: true,
        authProvider: true,
        passwordHash: true,
      },
    });
    if (existing) return conflict(existing);

    // phoneToken — the relay/WS bearer for the Android APK. Bundle A
    // (2026-05-28, fix C2) removed the cuid() DB default precisely so that
    // every user-create site mints its own crypto-random value; this is the
    // same generation the Google callback uses. Getting this wrong would hand
    // out a guessable relay credential.
    const phoneToken = crypto.randomBytes(32).toString('base64url');

    // Mint the invite token BEFORE the insert so its hash is part of the same
    // INSERT — the account is born claimable, and there is no window in which a
    // user row exists with no way to activate it.
    const invite = mintPasswordSetToken(INVITE_TTL_MS);

    // One transaction: the account, its comp (if any), and the audit trail all
    // land together or not at all. An audited-but-absent account, or a comped
    // email with no account, are both states nobody could explain later.
    const created = await db
      .$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            name,
            // No password: the invitee sets their own. Note this also means the
            // account cannot be signed into until the invite is redeemed —
            // /api/auth/login rejects passwordHash:null.
            passwordHash: null,
            // An admin vouched for this address, so there is nothing to verify;
            // sending a verification email on top of the invite would be two
            // links doing one job.
            emailVerified: true,
            authProvider: 'email',
            phoneToken,
            signupIp: getClientIp(req),
            invitedBy: gate.adminEmail,
            ...invite.fields,
          },
          select: { id: true, email: true, name: true, createdAt: true },
        });

        if (freeAccess) {
          // THE shared grant — same upsert + same append-only FreeAccessAudit
          // 'grant' row that POST /api/admin/free-access writes. Account-create
          // comps are PERMANENT (expiresAt null); a time-boxed comp is granted
          // via the free-access panel. `tx` is the interactive-transaction
          // client, now the 5th arg after the expiresAt param.
          await grantFreeAccess(email, gate.adminEmail, note, null, tx);
        }

        // Account-lifecycle audit. Separate from the free-access audit on
        // purpose: comping an email and minting an account are different acts,
        // and an append-only ledger can never relabel its verbs later.
        await tx.adminUserAudit.create({
          data: {
            action: 'user_create',
            email,
            actor: gate.adminEmail,
            targetId: user.id,
            freeAccess,
            note,
          },
        });

        return user;
      })
      .catch(async (e: unknown) => {
        // Lost the race against a concurrent create (or a signup landing
        // between the pre-check and here). Report the same 409, not a 500.
        if (isUniqueViolation(e)) {
          const row = await db.user.findUnique({
            where: { email },
            select: {
              id: true,
              email: true,
              createdAt: true,
              authProvider: true,
              passwordHash: true,
            },
          });
          if (row) return { __conflict: row } as const;
        }
        throw e;
      });

    if ('__conflict' in created) return conflict(created.__conflict);

    const url = buildSetPasswordUrl(invite.rawToken);

    // Mail is best-effort BY DESIGN. The account is already committed; a Resend
    // outage must not undo it. The outcome is reported so the panel can fall
    // back to "invite failed — copy this link instead".
    let emailSent = false;
    let emailError: string | null = null;
    try {
      await sendAdminInviteEmail({
        email,
        url,
        name,
        invitedBy: gate.adminEmail,
        freeAccess,
      });
      emailSent = true;
    } catch (e) {
      // Log the failure, never the URL or the token.
      console.error('[AdminUsers] invite email failed for', email, e);
      emailError = e instanceof Error ? e.message : 'Unknown mail error';
    }

    console.warn(
      `[AdminUsers] created ${email} by ${gate.adminEmail} at ${new Date().toISOString()} (freeAccess=${freeAccess}, emailSent=${emailSent})`,
    );

    return NextResponse.json(
      {
        user: {
          id: created.id,
          email: created.email,
          name: created.name ?? null,
          freeAccess,
          createdAt: created.createdAt.toISOString(),
        },
        invite: {
          url,
          expiresAt: invite.expiresAt.toISOString(),
          emailSent,
          emailError,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    console.error('[AdminUsers] POST error:', e);
    return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
  }
}

/**
 * Mint a fresh invite for an EXISTING, un-redeemed, admin-invited account.
 * See the RESEND note at the top of this file for the refusal rules.
 */
async function resendInvite(email: string, note: string | null, actor: string) {
  const existing = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      authProvider: true,
      passwordHash: true,
    },
  });

  // Nothing to resend to. Distinct from 409: the admin's next move is "create
  // it", not "look at it".
  if (!existing) {
    return NextResponse.json(
      { error: RESEND_REFUSAL_MESSAGE.user_not_found, code: 'user_not_found' },
      { status: 404 },
    );
  }

  // ⛔ Out of scope by design — this is not a password reset. The rule (and the
  // reasoning behind each half of it) lives in lib/inviteResend-core.js, shared
  // verbatim with the admin panel so the UI cannot offer what this refuses.
  const refusal = resendRefusal({
    hasPassword: existing.passwordHash !== null,
    authProvider: existing.authProvider,
  });
  if (refusal) {
    return NextResponse.json(
      { error: RESEND_REFUSAL_MESSAGE[refusal], code: refusal },
      { status: 409 },
    );
  }

  const invite = mintPasswordSetToken(INVITE_TTL_MS);

  // The refusal conditions are re-asserted HERE, in the WHERE clause, so a
  // redemption landing between the read above and this write cannot be
  // overwritten. count === 0 means the account changed under us.
  const rotated = await db.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: existing.id, passwordHash: null, authProvider: 'email' },
      data: invite.fields,
    });
    if (count !== 1) return false;

    // Its own verb in the append-only ledger. Re-issuing a credential-bearing
    // link is a distinct act from creating the account and must read as one.
    await tx.adminUserAudit.create({
      data: {
        action: 'user_invite_resend',
        email: existing.email,
        actor,
        targetId: existing.id,
        freeAccess: false,
        note,
      },
    });
    return true;
  });

  if (!rotated) {
    return NextResponse.json(
      {
        error:
          'That account was activated while this request was in flight. Nothing was changed.',
        code: 'already_redeemed',
      },
      { status: 409 },
    );
  }

  const comped = await db.freeAccessEmail
    .findUnique({ where: { email: existing.email }, select: { id: true } })
    .catch(() => null);

  const url = buildSetPasswordUrl(invite.rawToken);

  // Same best-effort delivery as creation: the OLD link is already dead, so a
  // mail failure must still surface the new link rather than roll anything back.
  let emailSent = false;
  let emailError: string | null = null;
  try {
    await sendAdminInviteEmail({
      email: existing.email,
      url,
      name: existing.name,
      invitedBy: actor,
      freeAccess: comped !== null,
    });
    emailSent = true;
  } catch (e) {
    console.error('[AdminUsers] resend email failed for', existing.email, e);
    emailError = e instanceof Error ? e.message : 'Unknown mail error';
  }

  console.warn(
    `[AdminUsers] resent invite for ${existing.email} by ${actor} at ${new Date().toISOString()} (emailSent=${emailSent})`,
  );

  return NextResponse.json(
    {
      user: {
        id: existing.id,
        email: existing.email,
        name: existing.name ?? null,
        freeAccess: comped !== null,
        createdAt: existing.createdAt.toISOString(),
      },
      invite: {
        url,
        expiresAt: invite.expiresAt.toISOString(),
        emailSent,
        emailError,
      },
      resent: true,
    },
    { status: 200 },
  );
}

/** Prisma unique-constraint violation, without importing the runtime error class. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/**
 * 409 for an email that already has an account. Reports enough state for the
 * admin to act (is it a Google account? does it already have a password?)
 * without leaking a hash or a token.
 */
async function conflict(row: {
  id: string;
  email: string;
  createdAt: Date;
  authProvider: string;
  passwordHash: string | null;
}) {
  const comped = await db.freeAccessEmail.findUnique({
    where: { email: row.email },
    select: { id: true },
  });
  return NextResponse.json(
    {
      error: 'An account with that email already exists',
      code: 'user_exists',
      user: {
        id: row.id,
        email: row.email,
        createdAt: row.createdAt.toISOString(),
        authProvider: row.authProvider,
        hasPassword: row.passwordHash !== null,
        freeAccess: comped !== null,
      },
    },
    { status: 409 },
  );
}
