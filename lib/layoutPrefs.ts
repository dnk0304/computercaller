import { z } from 'zod';

// ---------------------------------------------------------------------------
// Layout preferences — per-user desktop dashboard layout (Phase 1: presets +
// save-to-account). Dispatch forge/layout-prefs-backend (2026-09-01).
//
// Single source of truth for the SHAPE of a saved layout and for what each
// preset contains. Consumed by:
//   - app/api/prefs/layout/route.ts   (GET/PUT persistence)
//   - hooks/useLayoutPrefs.ts         (client cache + reconcile)
//   - Pixel's Settings "Layout" UI    (renders POWER_DEFAULT / PHONELINK_DEFAULT)
//
// Dennis decisions (LOCKED 2026-09-01): D2 = RICHER per-module config (not a
// single density toggle). D5 = desktop dashboard ONLY — Phone Mode untouched.
//
// Backward-compat contract: null/invalid stored prefs MUST resolve to the power
// default (today's exact layout). parseLayoutPrefs never throws; on any invalid
// or unknown-version input it returns null so callers fall back to power.
// ---------------------------------------------------------------------------

export type LayoutPreset = 'power' | 'phonelink' | 'custom';
export type ModuleId = 'notifications' | 'quickdial' | 'recentcalls' | 'threads';
export type Density = 'compact' | 'comfortable';

export const MODULE_IDS: readonly ModuleId[] = [
  'notifications',
  'quickdial',
  'recentcalls',
  'threads',
] as const;

// Shared per-module fields. `order` is a Phase-2 (drag-and-drop) enabler — it
// carries the render order now so the schema need not change when DnD lands.
const density = z.enum(['compact', 'comfortable']);
const baseFields = {
  visible: z.boolean().default(true),
  // clamp order to a sane, non-negative integer range; Phase-2 reorders within it.
  order: z.number().int().min(0).max(99),
  density: density.default('comfortable'),
};

// Per-module discriminated union on `id`. Unknown keys are stripped (zod object
// default). Every `options` field has a default so partial payloads normalize.
const notificationsSchema = z.object({
  id: z.literal('notifications'),
  ...baseFields,
  variant: z.enum(['strip', 'feed']).default('strip'),
});

const quickdialSchema = z.object({
  id: z.literal('quickdial'),
  ...baseFields,
  variant: z.enum(['grid', 'list']).default('grid'),
  options: z
    .object({ showFavorites: z.boolean().default(true) })
    .default({ showFavorites: true }),
});

const recentcallsSchema = z.object({
  id: z.literal('recentcalls'),
  ...baseFields,
  variant: z.enum(['detailed', 'minimal']).default('detailed'),
  options: z
    .object({
      showDuration: z.boolean().default(true),
      showTimestamps: z.boolean().default(true),
    })
    .default({ showDuration: true, showTimestamps: true }),
});

const threadsSchema = z.object({
  id: z.literal('threads'),
  ...baseFields,
  previewLines: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  options: z
    .object({
      showAvatars: z.boolean().default(true),
      showUnreadBadges: z.boolean().default(true),
    })
    .default({ showAvatars: true, showUnreadBadges: true }),
});

export const moduleConfigSchema = z.discriminatedUnion('id', [
  notificationsSchema,
  quickdialSchema,
  recentcallsSchema,
  threadsSchema,
]);

// LayoutPrefs — the persisted shape. `version` gates forward-compat: anything
// other than 1 is treated as unknown → parse returns null → power fallback.
export const layoutPrefsSchema = z.object({
  version: z.literal(1),
  preset: z.enum(['power', 'phonelink', 'custom']),
  // At most one entry per module id. Optional — missing modules resolve to the
  // preset default via resolveLayoutPrefs().
  modules: z.array(moduleConfigSchema).max(MODULE_IDS.length).optional(),
});

export type NotificationsConfig = z.infer<typeof notificationsSchema>;
export type QuickdialConfig = z.infer<typeof quickdialSchema>;
export type RecentcallsConfig = z.infer<typeof recentcallsSchema>;
export type ThreadsConfig = z.infer<typeof threadsSchema>;
export type ModuleConfig = z.infer<typeof moduleConfigSchema>;
export type LayoutPrefs = z.infer<typeof layoutPrefsSchema>;

// ---------------------------------------------------------------------------
// Preset defaults — the single source of truth for what each preset contains.
// Pixel renders preview cards from these; the resolver fills missing modules
// from them. POWER_DEFAULT mirrors today's shipped dashboard exactly.
// ---------------------------------------------------------------------------

export const POWER_DEFAULT: Required<LayoutPrefs> = {
  version: 1,
  preset: 'power',
  modules: [
    { id: 'notifications', visible: true, order: 0, density: 'comfortable', variant: 'strip' },
    {
      id: 'quickdial',
      visible: true,
      order: 1,
      density: 'comfortable',
      variant: 'grid',
      options: { showFavorites: true },
    },
    {
      id: 'recentcalls',
      visible: true,
      order: 2,
      density: 'comfortable',
      variant: 'detailed',
      options: { showDuration: true, showTimestamps: true },
    },
    {
      id: 'threads',
      visible: true,
      order: 3,
      density: 'comfortable',
      previewLines: 1,
      options: { showAvatars: true, showUnreadBadges: true },
    },
  ],
};

// Phone Link — INSPIRED BY (D1), not a clone: single-focus feel, notifications
// as a right-hand feed, roomier rows. Pixel tunes the visual; this fixes the
// config contract.
export const PHONELINK_DEFAULT: Required<LayoutPrefs> = {
  version: 1,
  preset: 'phonelink',
  modules: [
    {
      id: 'quickdial',
      visible: true,
      order: 0,
      density: 'comfortable',
      variant: 'list',
      options: { showFavorites: true },
    },
    {
      id: 'recentcalls',
      visible: true,
      order: 1,
      density: 'comfortable',
      variant: 'detailed',
      options: { showDuration: true, showTimestamps: true },
    },
    {
      id: 'threads',
      visible: true,
      order: 2,
      density: 'comfortable',
      previewLines: 2,
      options: { showAvatars: true, showUnreadBadges: true },
    },
    { id: 'notifications', visible: true, order: 3, density: 'comfortable', variant: 'feed' },
  ],
};

/** Full preset default for a given preset. 'custom' with no modules resolves to power. */
export function presetDefault(preset: LayoutPreset): Required<LayoutPrefs> {
  return preset === 'phonelink' ? PHONELINK_DEFAULT : POWER_DEFAULT;
}

/**
 * Parse untrusted input (DB JSON or a PUT body) into a valid LayoutPrefs.
 * Never throws. Returns null on invalid shape or unknown/absent version so
 * every caller falls back to the power default (zero change for existing users).
 */
export function parseLayoutPrefs(input: unknown): LayoutPrefs | null {
  const result = layoutPrefsSchema.safeParse(input);
  if (!result.success) return null;
  // Reject duplicate module ids — the union allows one entry each; a payload
  // with two 'threads' entries is malformed. Last-writer-wins would hide a bug.
  if (result.data.modules) {
    const ids = result.data.modules.map((m) => m.id);
    if (new Set(ids).size !== ids.length) return null;
  }
  return result.data;
}

/**
 * Resolve a (possibly null / partial) LayoutPrefs into a fully-populated set of
 * all four modules, in render order. Missing modules are filled from the row's
 * preset default. This is what the dashboard renders from — call it once and
 * read a guaranteed-complete module list.
 */
export function resolveLayoutPrefs(prefs: LayoutPrefs | null): Required<LayoutPrefs> {
  if (!prefs) return POWER_DEFAULT;
  const base = presetDefault(prefs.preset);
  const provided = new Map<ModuleId, ModuleConfig>();
  for (const m of prefs.modules ?? []) provided.set(m.id, m);
  const modules = base.modules.map((def) => provided.get(def.id) ?? def);
  return { version: 1, preset: prefs.preset, modules };
}
