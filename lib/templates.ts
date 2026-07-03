import type { Template } from '@prisma/client';
import type { EntitlementState } from '@/lib/entitlement';

// Item C1 (2026-05-27) — shared template helpers used by the /api/templates routes.

// Max templates per user. Enforced in POST /api/templates (count → 409) so the
// cap holds even if the UI is bypassed; deliberately NOT a DB constraint so it
// can change without a migration.
export const TEMPLATE_LIMIT = 15;

// Trial-tier cap (dispatch forge/trial7-caps-whopcard, 2026-07-03). Dennis:
// "during free trial - max 3 message templates". Non-paying users (trialing,
// trial_expired, expired, none) get this reduced cap; paying/privileged users
// (admin, allowlisted, active) keep the full TEMPLATE_LIMIT. Code-constant,
// no env — matches the TEMPLATE_LIMIT pattern.
export const TRIAL_TEMPLATE_LIMIT = 3;

// Effective template create-limit for a given entitlement state. The full cap
// applies ONLY to paying/privileged states; everyone else is on the trial cap.
// Single source of truth so the POST enforcement and GET disclosure agree.
export function effectiveTemplateLimit(state: EntitlementState): number {
  const paying = state === 'admin' || state === 'allowlisted' || state === 'active';
  return paying ? TEMPLATE_LIMIT : TRIAL_TEMPLATE_LIMIT;
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
