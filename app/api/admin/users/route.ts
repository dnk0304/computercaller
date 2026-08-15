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
          // 'grant' row that POST /api/admin/free-access writes.
          await grantFreeAccess(email, gate.adminEmail, note, tx);
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
