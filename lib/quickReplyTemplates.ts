import type { QuickReplyTemplate } from '@prisma/client';
import type { EntitlementState } from '@/lib/entitlement';

// Dispatch CC-quickreply-templates-v2 (2026-06-03) — shared helpers used by
// the /api/quick-replies routes. Mirrors lib/templates.ts conventions; the
// quick-reply store is SEPARATE from the normal SMS-templates store and only
// drives the reply-and-hangup chips on an incoming call.

// Max quick-replies per user. Dennis-locked at 5. Enforced in POST
// /api/quick-replies (count → 409) so the cap holds even if the UI is
// bypassed; deliberately NOT a DB constraint so it can change without a
// migration (matches the TEMPLATE_LIMIT pattern).
export const QUICK_REPLY_LIMIT = 5;

// Trial-tier cap (dispatch forge/trial7-caps-whopcard, 2026-07-03). Dennis:
// "max 1 quick reply template" during the free trial. Non-paying users
// (trialing, trial_expired, expired, none) get this reduced cap; paying/
// privileged users (admin, allowlisted, active) keep the full
// QUICK_REPLY_LIMIT. Code-constant, no env.
export const TRIAL_QUICK_REPLY_LIMIT = 1;

// Effective quick-reply create-limit for a given entitlement state. Full cap
// applies ONLY to paying/privileged states; everyone else is on the trial cap.
export function effectiveQuickReplyLimit(state: EntitlementState): number {
  const paying = state === 'admin' || state === 'allowlisted' || state === 'active';
  return paying ? QUICK_REPLY_LIMIT : TRIAL_QUICK_REPLY_LIMIT;
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
