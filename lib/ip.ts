/**
 * lib/ip.ts — resolve the real client IP behind Cloudflare → Coolify/Traefik
 * (dispatch forge/trial-lock-and-admin-dashboard, 2026-07-03).
 *
 * TRUST ASSUMPTION: computercaller.com sits behind Cloudflare, which fronts the
 * Coolify/Traefik reverse proxy. Cloudflare OVERWRITES `cf-connecting-ip` with
 * the true client IP on every request and cannot be spoofed by the client
 * (Cloudflare strips inbound copies). `x-forwarded-for` / `x-real-ip` are only
 * trustworthy because we are always behind that proxy chain — a request that
 * reached the app WITHOUT going through Cloudflare (e.g. someone hitting the
 * container's internal address directly) could forge these. That path is not
 * publicly reachable in the current deploy, so we accept the headers. If the
 * app is ever exposed without Cloudflare in front, this helper must be
 * revisited (an attacker could then forge signupIp to dodge the same-IP flag).
 *
 * Priority: cf-connecting-ip → first hop of x-forwarded-for → x-real-ip → null.
 * Returns null (not '') when nothing usable is present, so callers store SQL
 * NULL rather than an empty string that would then wrongly cluster in the
 * same-IP abuse check.
 */

export function getClientIp(req: { headers: Headers }): string | null {
  const h = req.headers;

  const cf = h.get('cf-connecting-ip');
  if (cf && cf.trim()) return cf.trim();

  // x-forwarded-for is a comma-separated chain "client, proxy1, proxy2".
  // The FIRST hop is the originating client (Cloudflare appends, so the first
  // entry is what Cloudflare saw). Take it, trimmed.
  const xff = h.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }

  const xreal = h.get('x-real-ip');
  if (xreal && xreal.trim()) return xreal.trim();

  return null;
}
