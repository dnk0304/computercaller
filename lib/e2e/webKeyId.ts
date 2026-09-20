/**
 * lib/e2e/webKeyId.ts — the remembered DeviceKey ROW id for this browser
 * (E2E-P2.3 (c)).
 *
 * A leaf module with no imports, and that is the reason it exists rather than
 * living in revokeWebKey.ts: lib/e2e/webKey.ts writes the cache (it is the only
 * place that sees the register response) and revokeWebKey.ts reads it (it is
 * the only place that needs an id), and webKey.ts <-> revokeWebKey.ts would be
 * an import cycle. A cycle whose safety depends on which module the bundler
 * happens to evaluate first is a bug waiting for a refactor.
 *
 * MODULE SCOPE, NOT STORAGE, DELIBERATELY. This is a cache, never a source of
 * truth: `resolveOwnWebDeviceKeyId` can always re-derive the id from the
 * persisted key's public half. A persisted id would have to carry a version tag
 * and an unknown-version guard (RESUME-PROTOCOL rule 6) to be legal, and would
 * buy only a GET on a path the user takes once.
 */

let rememberedId: string | null = null;

/** Record the row id the register route echoed. Non-strings never overwrite. */
export function rememberWebDeviceKeyId(id: unknown): void {
  if (typeof id === 'string' && id.length > 0) rememberedId = id;
}

/** Drop the cache — the id no longer names a live row (or the test wants a clean slate). */
export function forgetWebDeviceKeyId(): void {
  rememberedId = null;
}

/** Read the cache. null when this browser has not registered a key this session. */
export function peekWebDeviceKeyId(): string | null {
  return rememberedId;
}
