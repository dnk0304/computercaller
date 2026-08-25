/**
 * scripts/partner-key-issue.cjs — admin-only, hand-issued partner API keys
 * (SDK-PKG-2 Phase 1, dispatch forge/partner-api-keys, 2026-08-25).
 *
 * Phase 1 is DELIBERATELY not self-serve: keys are minted by an operator (Dennis)
 * running this CLI. That is the lowest-risk, lowest-surface issuance path — no
 * new authenticated admin HTTP endpoint that mints call-authorizing credentials,
 * nothing for the Security audit to have to reason about beyond this one script.
 *
 * Run it INSIDE the app container (so DATABASE_URL + the generated Prisma client
 * resolve exactly like the running app — see the repo's one-off-script note):
 *
 *   node scripts/partner-key-issue.cjs issue --name "Acme Co" --slug acme \
 *        --scopes call,presence --rate 120
 *   node scripts/partner-key-issue.cjs issue --slug acme --scopes call   # add a key to an existing partner
 *   node scripts/partner-key-issue.cjs revoke --keyId ab12cd34ef56
 *   node scripts/partner-key-issue.cjs suspend --slug acme
 *   node scripts/partner-key-issue.cjs activate --slug acme
 *   node scripts/partner-key-issue.cjs list
 *
 * SECURITY: the plaintext secret is printed EXACTLY ONCE, at issuance, and is
 * NEVER stored (only SHA-256(secret) is persisted). If it is lost, revoke the key
 * and issue a new one — there is no recovery, by design.
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CJS ops script. */
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const PARTNER_KEY_PREFIX = 'ccp_live_';
const DEFAULT_SCOPES = ['call'];
const VALID_SCOPES = new Set(['call', 'presence', 'read_logs', 'sms']);

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function generateKey() {
  const keyId = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { keyId, secret, token: `${PARTNER_KEY_PREFIX}${keyId}.${secret}`, hashedSecret: hashSecret(secret) };
}

// Minimal `--flag value` / `--flag=value` parser.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const db = new PrismaClient();

  try {
    switch (cmd) {
      case 'issue': {
        const slug = typeof args.slug === 'string' ? args.slug.trim().toLowerCase() : '';
        if (!slug) die('--slug is required (url/log-safe handle, e.g. acme)');

        const scopes = (typeof args.scopes === 'string' ? args.scopes : DEFAULT_SCOPES.join(','))
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const s of scopes) if (!VALID_SCOPES.has(s)) die(`unknown scope '${s}' (valid: ${[...VALID_SCOPES].join(', ')})`);

        const rate = args.rate !== undefined ? Number(args.rate) : null;
        if (rate !== null && (!Number.isInteger(rate) || rate <= 0)) die('--rate must be a positive integer (mints/min)');

        // Find or create the Partner.
        let partner = await db.partner.findUnique({ where: { slug } });
        if (!partner) {
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) die(`partner '${slug}' does not exist — pass --name to create it`);
          partner = await db.partner.create({
            data: { name, slug, plan: typeof args.plan === 'string' ? args.plan : null },
          });
          console.log(`Created partner: ${partner.name} (slug=${partner.slug}, id=${partner.id})`);
        }

        const key = generateKey();
        const row = await db.partnerApiKey.create({
          data: {
            partnerId: partner.id,
            keyId: key.keyId,
            hashedSecret: key.hashedSecret, // ONLY the hash — never the plaintext
            scopes,
            rateLimitPerMin: rate,
          },
        });

        console.log('\n──────────────────────────────────────────────────────────────');
        console.log('  PARTNER API KEY ISSUED — copy the secret NOW, shown ONCE only');
        console.log('──────────────────────────────────────────────────────────────');
        console.log(`  partner   : ${partner.name} (${partner.slug})`);
        console.log(`  keyId     : ${key.keyId}`);
        console.log(`  scopes    : ${scopes.join(', ')}`);
        console.log(`  rateLimit : ${rate ?? 'default'} mints/min`);
        console.log(`  apiKey id : ${row.id}`);
        console.log('\n  FULL KEY (give to the partner over a secure channel):\n');
        console.log(`      ${key.token}\n`);
        console.log('  Stored at rest: keyId + SHA-256(secret). The plaintext above');
        console.log('  is NOT recoverable. Lost it? Revoke this keyId and re-issue.');
        console.log('──────────────────────────────────────────────────────────────\n');
        break;
      }

      case 'revoke': {
        const keyId = typeof args.keyId === 'string' ? args.keyId.trim() : '';
        if (!keyId) die('--keyId is required');
        const row = await db.partnerApiKey.findUnique({ where: { keyId } });
        if (!row) die(`no key with keyId '${keyId}'`);
        if (row.status === 'revoked') {
          console.log(`keyId ${keyId} is already revoked.`);
          break;
        }
        await db.partnerApiKey.update({
          where: { id: row.id },
          data: { status: 'revoked', revokedAt: new Date() },
        });
        console.log(`Revoked keyId ${keyId} (partnerId=${row.partnerId}). It now fails auth closed.`);
        break;
      }

      case 'suspend':
      case 'activate': {
        const slug = typeof args.slug === 'string' ? args.slug.trim().toLowerCase() : '';
        if (!slug) die('--slug is required');
        const partner = await db.partner.findUnique({ where: { slug } });
        if (!partner) die(`no partner with slug '${slug}'`);
        const status = cmd === 'suspend' ? 'suspended' : 'active';
        await db.partner.update({ where: { id: partner.id }, data: { status } });
        console.log(`Partner '${slug}' is now ${status}. ${status === 'suspended' ? 'ALL its keys fail auth closed.' : 'Its active keys work again.'}`);
        break;
      }

      case 'list': {
        const partners = await db.partner.findMany({
          orderBy: { createdAt: 'asc' },
          include: {
            apiKeys: {
              orderBy: { createdAt: 'asc' },
              select: { keyId: true, scopes: true, status: true, rateLimitPerMin: true, lastUsedAt: true, revokedAt: true },
            },
          },
        });
        if (partners.length === 0) {
          console.log('No partners.');
          break;
        }
        for (const p of partners) {
          console.log(`\n${p.name}  [slug=${p.slug}, status=${p.status}, plan=${p.plan ?? '-'}]`);
          if (p.apiKeys.length === 0) console.log('  (no keys)');
          for (const k of p.apiKeys) {
            console.log(
              `  - keyId=${k.keyId}  status=${k.status}  scopes=[${k.scopes.join(',')}]  rate=${k.rateLimitPerMin ?? 'default'}  lastUsed=${k.lastUsedAt ? k.lastUsedAt.toISOString() : 'never'}`,
            );
          }
        }
        console.log('');
        break;
      }

      default:
        console.log('Usage: node scripts/partner-key-issue.cjs <issue|revoke|suspend|activate|list> [flags]');
        console.log('  issue    --slug <s> [--name <n>] [--scopes call,presence] [--rate <n>] [--plan <p>]');
        console.log('  revoke   --keyId <id>');
        console.log('  suspend  --slug <s>');
        console.log('  activate --slug <s>');
        console.log('  list');
        process.exit(cmd ? 1 : 0);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
