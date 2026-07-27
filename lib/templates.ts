import type { Template } from '@prisma/client';
import type { EntitlementResult } from '@/lib/entitlement';

// Item C1 (2026-05-27) — shared template helpers used by the /api/templates routes.

// Absolute max templates any tier can grant (Pro = 30). Since the 3-tier gating
// (2026-07-27, dispatch feature/tier-gating) the REAL per-user cap is tier-
// driven (Solo 3 / Plus 10 / Pro 30) and comes from the entitlement result —
// see effectiveTemplateLimit. This constant is retained only as the client-side
// pre-fetch seed / fallback / render slice ceiling (hooks/useTemplates.ts): it
// must be >= the largest tier so a legitimately-provisioned Pro user's rows are
// never truncated before the server's authoritative `limit` arrives. Enforced
// server-side in POST /api/templates (count → 409); deliberately NOT a DB
// constraint so caps can change without a migration.
export const TEMPLATE_LIMIT = 30;

// Solo-tier / non-paying template cap. Kept as a named constant for the tests
// and the historical trial-cap reference; the authoritative value now flows
// from TIER_LIMITS.solo.templates via the entitlement result.
export const TRIAL_TEMPLATE_LIMIT = 3;

// Effective template create-limit for an evaluated entitlement result. Tier-
// aware (2026-07-27): the cap is TIER_LIMITS[tier].templates, already resolved
// on the result by lib/entitlement-core (admin/allowlisted → Pro/30; active/
// trialing → their planId's tier; none/expired → Solo/3). Single source of
// truth so the POST enforcement and GET disclosure agree.
export function effectiveTemplateLimit(ent: EntitlementResult): number {
  return ent.limits.templates;
}

// The wire shape the client consumes. createdAt is epoch-ms (number) so the
// existing client type `{ id, name, body, createdAt: number }` is unchanged;
// sortOrder is added.
export interface TemplateDTO {
  id: string;
  name: string;
  body: string;
  sortOrder: number;
  createdAt: number;
}

// Serialize a Prisma Template row into the wire DTO.
export function serializeTemplate(t: Template): TemplateDTO {
  return {
    id: t.id,
    name: t.name,
    body: t.body,
    sortOrder: t.sortOrder,
    createdAt: t.createdAt.getTime(),
  };
}
