/**
 * scripts/backfill-free-tier-grandfather.mjs — grandfather every EXISTING
 * no-card free-tier user before FREE_TIER is switched off (2026-09-13, dispatch
 * forge/cardfirst-revert).
 *
 * WHAT IT DOES
 *   Sets `User.freeTierGrandfathered = true` on every User that
 *     (a) has NO Subscription row, AND
 *     (b) was created STRICTLY BEFORE the cutoff instant (default: now).
 *   Those users signed up under an advertised free offer. Card-first applies to
 *   new signups only; these accounts keep the free tier permanently.
 *
 * Dennis's decision, 2026-09-13 13:45 — verbatim: "Let the ones which already
 * are. But from now on, card required."
 *
 * WHY A ONE-OFF SCRIPT AND NOT PART OF THE MIGRATION
 *   A migration runs on every deploy. If the backfill lived there, a redeploy
 *   AFTER the flip would silently grandfather every user who had since signed
 *   up card-first and churned before paying — quietly re-opening the free tier
 *   forever. Keeping it a manual, counted, dry-run-first step means a human
 *   sees the exact population before it is written, exactly once.
 *
 * SAFETY
 *   • DRY RUN IS THE DEFAULT. Without `--apply` it reads, reports, and exits 0
 *     having written nothing.
 *   • RE-RUNNABLE / IDEMPOTENT. The write is scoped to rows still at `false`,
 *     so a second run reports 0 eligible and converges on the same state.
 *   • NEVER UN-GRANDFATHERS. No path in this script writes `false`. A row
 *     already true is left alone, whatever its other columns say.
 *   • NEVER TOUCHES A USER WITH A SUBSCRIPTION ROW. The live payer (Sendy), the
 *     6 trialists and the 2 comped internal rows are excluded by
 *     `subscription: { is: null }` and are never read for update. Untouched.
 *   • ONE TRANSACTION. The census, the listing and the write share a single
 *     interactive transaction, so the number reported and the number written
 *     describe the same instant — no row can slip in between them.
 *   • SELF-VERIFYING. After the write, still inside the transaction, it asserts
 *     that the target set is now empty and that the row count written equals
 *     the count reported. Either mismatch throws and rolls the whole thing
 *     back rather than leaving a half-grandfathered population behind.
 *   • Admin / reviewer / allowlisted accounts are harmless either way:
 *     entitlement rules (1) and (2) short-circuit to allowed:true long before
 *     rule (3) is reached, so grandfathering them changes nothing. They are
 *     included when they have no Subscription row simply so the set is exactly
 *     "every pre-flip account", with no special cases to reason about later.
 *
 * USAGE
 *   node scripts/backfill-free-tier-grandfather.mjs                 # dry run
 *   node scripts/backfill-free-tier-grandfather.mjs --apply         # write
 *   node scripts/backfill-free-tier-grandfather.mjs --before=2026-09-13T12:00:00Z --apply
 *
 *   --apply           actually write (default: dry run)
 *   --before <ISO>    cutoff; only users created STRICTLY BEFORE it qualify.
 *                     Defaults to the moment the script starts. Pass the FLIP
 *                     time explicitly if the backfill and the flip are not
 *                     simultaneous — always the flip time, never later.
 *   --verbose         list every affected email (the population is ~13).
 *
 * Requires DATABASE_URL. Run it BEFORE setting FREE_TIER=off.
 * Its logic is proven against a prod-shaped mock in
 * tests/backfill-free-tier-grandfather.test.mjs (no database required).
 *
 * The flag is irrelevant to this script: it never reads FREE_TIER and writes
 * the same rows whether the gate is on or off.
 */

import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';

/**
 * THE ONE PREDICATE. Defined once and reused for the census, the listing, the
 * write and the post-write assertion, so the number reported can never describe
 * a different set than the number written.
 *
 * `freeTierGrandfathered: false` is what makes the script re-runnable: an
 * already-stamped row drops out of the set entirely on the next run.
 *
 * @param {Date} cutoff
 */
export function targetWhere(cutoff) {
  return {
    subscription: { is: null },
    createdAt: { lt: cutoff },
    freeTierGrandfathered: false,
  };
}

/**
 * The testable core. Takes any Prisma-shaped client (the real one, or a mock)
 * so its behaviour can be proven without a database.
 *
 * @param {{ $transaction: Function }} db
 * @param {{ cutoff: Date, apply: boolean }} opts
 */
export async function runBackfill(db, { cutoff, apply }) {
  const target = targetWhere(cutoff);

  return db.$transaction(async (tx) => {
    const totalUsers = await tx.user.count();
    const withSubscription = await tx.user.count({
      where: { subscription: { isNot: null } },
    });
    const alreadyGrandfathered = await tx.user.count({
      where: { freeTierGrandfathered: true },
    });
    // No-subscription users created AT OR AFTER the cutoff — the post-flip,
    // card-first population. Reported so that running the backfill LATE (after
    // real card-first signups exist) is visible rather than silent.
    const afterCutoff = await tx.user.count({
      where: { subscription: { is: null }, createdAt: { gte: cutoff } },
    });

    const candidates = await tx.user.findMany({
      where: target,
      select: { id: true, email: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    let updated = 0;
    if (apply && candidates.length > 0) {
      const res = await tx.user.updateMany({
        where: target,
        data: { freeTierGrandfathered: true },
      });
      updated = res.count;

      // Post-write assertions, INSIDE the transaction. Either failure rolls
      // back — a partial grandfathering is worse than no grandfathering,
      // because the missed accounts get locked out without anyone noticing.
      if (updated !== candidates.length) {
        throw new Error(
          `Backfill count mismatch: reported ${candidates.length}, wrote ${updated} — rolled back.`,
        );
      }
      const remaining = await tx.user.count({ where: target });
      if (remaining !== 0) {
        throw new Error(
          `Backfill incomplete: ${remaining} row(s) still match the target after the write — rolled back.`,
        );
      }
    }

    return { totalUsers, withSubscription, alreadyGrandfathered, afterCutoff, candidates, updated };
  });
}

function parseArgs(argv) {
  const args = { apply: false, before: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // Accept BOTH `--before X` and `--before=X`, and reject anything else
    // loudly. A silently-ignored flag on a one-shot data script is how a
    // cutoff quietly becomes "now" and a wider population than intended is
    // written.
    if (a === '--apply') args.apply = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--before') args.before = argv[++i] ?? null;
    else if (a.startsWith('--before=')) args.before = a.slice('--before='.length);
    else {
      console.error(`Unrecognised argument: ${a}`);
      console.error(
        'Usage: node scripts/backfill-free-tier-grandfather.mjs [--apply] [--before <ISO>] [--verbose]',
      );
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let cutoff;
  if (args.before === null) {
    cutoff = new Date();
  } else {
    cutoff = new Date(args.before);
    if (Number.isNaN(cutoff.getTime())) {
      console.error(`--before is not a parseable date: ${args.before}`);
      process.exit(2);
    }
  }

  const db = new PrismaClient();
  try {
    const report = await runBackfill(db, { cutoff, apply: args.apply });

    const mode = args.apply ? 'APPLY (written)' : 'DRY RUN (nothing written)';
    console.log('');
    console.log('  free-tier grandfather backfill —', mode);
    console.log('  cutoff (createdAt <)        :', cutoff.toISOString());
    console.log('  total users                 :', report.totalUsers);
    console.log('  users WITH a subscription   :', report.withSubscription, '(excluded — untouched)');
    console.log('  already grandfathered       :', report.alreadyGrandfathered);
    console.log('  no-sub users AFTER cutoff   :', report.afterCutoff, '(excluded — card-first)');
    console.log('  ELIGIBLE to grandfather     :', report.candidates.length);
    if (args.apply) console.log('  rows written                :', report.updated);
    console.log('');

    if (args.verbose || report.candidates.length <= 25) {
      for (const u of report.candidates) {
        console.log(`    ${u.createdAt.toISOString()}  ${u.email}`);
      }
      if (report.candidates.length > 0) console.log('');
    }

    if (!args.apply && report.candidates.length > 0) {
      console.log('  Re-run with --apply to write. Nothing has been changed.');
      console.log('');
    }
  } finally {
    await db.$disconnect();
  }
}

// Only run the CLI when executed directly — importing this module (the test
// does) must not open a Prisma connection or read process.argv.
// (pathToFileURL, not string concatenation — a naive `file://${argv[1]}` does
// not round-trip a Windows drive path and the guard would never fire here.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[backfill-free-tier-grandfather] FAILED:', err);
    process.exit(1);
  });
}
