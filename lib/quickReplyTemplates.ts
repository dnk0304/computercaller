import type { QuickReplyTemplate } from '@prisma/client';
import type { EntitlementResult } from '@/lib/entitlement';

// Dispatch CC-quickreply-templates-v2 (2026-06-03) — shared helpers used by
// the /api/quick-replies routes. Mirrors lib/templates.ts conventions; the
// quick-reply store is SEPARATE from the normal SMS-templates store and only
// drives the reply-and-hangup chips on an incoming call.

// Absolute max quick-replies any tier can grant (Pro = 5). Retained as the
// client-side render/fallback ceiling; the REAL per-user cap is tier-driven and
// comes from the entitlement result — see effectiveQuickReplyLimit.
export const QUICK_REPLY_LIMIT = 5;

// Trial-tier cap. Named constant kept for the historical reference and tests;
// the authoritative value now flows from TIER_LIMITS.trial.quickReplies (0) via
// the entitlement result.
export const TRIAL_QUICK_REPLY_LIMIT = 1;

// Effective quick-reply create-limit for an evaluated entitlement result.
//
// 2026-08-17 (dispatch forge/pricing-trial-limited): quick-replies are now
// enforced TIER-WIDE off the entitlement result's limit set — trial 0 / $5(plus)
// 3 / $7(pro) 5 — exactly like effectiveTemplateLimit. This supersedes the old
// STATE-based (paying=5 / trial=1) rule: it was correct while quick-replies were
// not a differentiator, but the limited trial (0) and the $5/$7 split (3/5) are
// real tier caps now, and grandfathered rows must keep their frozen cap — all of
// which the tier map already encodes. Single source: the same TIER_LIMITS the
// relay and /api/entitlement read.
export function effectiveQuickReplyLimit(ent: EntitlementResult): number {
  return ent.limits.quickReplies;
}

// The wire shape the client consumes. createdAt is epoch-ms (number) to match
// the TemplateDTO convention so the Pixel-side hook can reuse the same shape.
// label is normalized to `null` when absent (DB column is nullable).
export interface QuickReplyTemplateDTO {
  id: string;
  body: string;
  label: string | null;
  sortOrder: number;
  createdAt: number;
}

// Serialize a Prisma QuickReplyTemplate row into the wire DTO.
export function serializeQuickReplyTemplate(t: QuickReplyTemplate): QuickReplyTemplateDTO {
  return {
    id: t.id,
    body: t.body,
    label: t.label ?? null,
    sortOrder: t.sortOrder,
    createdAt: t.createdAt.getTime(),
  };
}
