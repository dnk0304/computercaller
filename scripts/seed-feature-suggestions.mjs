/**
 * scripts/seed-feature-suggestions.mjs — idempotent seed for the homepage
 * feature-voting widget (dispatch forge/feature-voting, 2026-09-02).
 *
 * Seeds the 4 initial suggestions. Safe to run repeatedly: each row is an
 * upsert keyed on the stable `slug`. Re-running NEVER duplicates a row and
 * NEVER resets voteCount / createdAt (the update clause touches only the
 * editorial fields title/description/status/sortOrder — vote data is left
 * exactly as the live table holds it).
 *
 * Run (Ken, once, after `prisma migrate deploy`):
 *   node scripts/seed-feature-suggestions.mjs
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// Order here is the display order (sortOrder ascending). chrome-extension is
// flagged in_progress — it is already on the roadmap (Dennis).
const SUGGESTIONS = [
  {
    slug: 'embedded-messenger-exe',
    title: 'Embedded messenger apps — desktop app (.exe)',
    description: 'Bundle messenger apps into a single desktop executable.',
    status: 'proposed',
    sortOrder: 10,
  },
  {
    slug: 'chrome-extension',
    title: 'Chrome extension',
    description: 'Use ComputerCaller straight from a Chrome extension.',
    status: 'in_progress',
    sortOrder: 20,
  },
  {
    slug: 'phone-mirroring',
    title: 'Phone mirroring',
    description: 'Mirror your phone screen to the desktop.',
    status: 'proposed',
    sortOrder: 30,
  },
  {
    slug: 'file-sharing',
    title: 'File sharing',
    description: 'Send and receive files between phone and desktop.',
    status: 'proposed',
    sortOrder: 40,
  },
];

async function main() {
  for (const s of SUGGESTIONS) {
    await db.featureSuggestion.upsert({
      where: { slug: s.slug },
      // Editorial fields only — voteCount/createdAt are intentionally omitted so
      // a re-seed can never wipe live votes.
      update: {
        title: s.title,
        description: s.description,
        status: s.status,
        sortOrder: s.sortOrder,
      },
      create: s,
    });
    console.log(`  upserted ${s.slug}`);
  }
  console.log(`Seeded ${SUGGESTIONS.length} feature suggestions.`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
