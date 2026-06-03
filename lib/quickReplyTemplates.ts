import type { QuickReplyTemplate } from '@prisma/client';

// Dispatch CC-quickreply-templates-v2 (2026-06-03) — shared helpers used by
// the /api/quick-replies routes. Mirrors lib/templates.ts conventions; the
// quick-reply store is SEPARATE from the normal SMS-templates store and only
// drives the reply-and-hangup chips on an incoming call.

// Max quick-replies per user. Dennis-locked at 5. Enforced in POST
// /api/quick-replies (count → 409) so the cap holds even if the UI is
// bypassed; deliberately NOT a DB constraint so it can change without a
// migration (matches the TEMPLATE_LIMIT pattern).
export const QUICK_REPLY_LIMIT = 5;

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
