import type { Template } from '@prisma/client';

// Item C1 (2026-05-27) — shared template helpers used by the /api/templates routes.

// Max templates per user. Enforced in POST /api/templates (count → 409) so the
// cap holds even if the UI is bypassed; deliberately NOT a DB constraint so it
// can change without a migration.
export const TEMPLATE_LIMIT = 15;

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
