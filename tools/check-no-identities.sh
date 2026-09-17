#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-no-identities.sh — no PERSONAL identity and no access-control env NAME
# may ship in PUBLIC client output.
#
# WHY (2026-09-17, dispatch forge/w-strip-email-literals): the entitlement core
# (lib/entitlement-core.js) carried two hardcoded email allowlists as string
# literals. It is plain CommonJS, so it cannot be tree-shaken; a 'use client'
# component (components/auth/LoginForm.tsx) imported lib/google -> lib/auth ->
# entitlement-core, which shipped the whole module — a real personal email
# address and the admin-by-email mechanism — to every visitor in a publicly
# fetchable _next/static chunk. Confirmed live and unauthenticated before the fix.
#
# SCOPE — client output only:
#   .next/static/**      the browser bundles (public)
#   chrome-extension/**  the unpacked extension (shipped to users verbatim)
# .next/server/** is deliberately NOT scanned: server chunks legitimately
# contain the env NAMES (process.env.ADMIN_EMAIL etc). Env VALUES never appear
# there either, because every read happens at call time from process.env.
#
# NOTE: this script never spells out a real personal address. Matching on the
# '@gmail.com' domain catches the old fallback literal without reproducing it.
#
# HOW IT WORKS: it extracts every email-shaped token and every banned env name
# from the client output, then subtracts an explicit, justified ALLOWED list.
# Anything left over fails the build. Token-based (not file-based) so a single
# intentional public address does not blind the check to a real leak in the
# same file.
#
# ⚠️ Do NOT silence a failure by adding to ALLOWED. The fix is to stop the
# client bundle importing the server module — see lib/nextPath.ts for the
# worked example. ALLOWED is only for strings that are PUBLIC BY DESIGN.
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Strings that are public by design and therefore may appear in client output.
ALLOWED=(
  # The published customer-support address, rendered in the footer/legal pages.
  'support@computercaller.com'
  # Fictional fixture data for the admin table's loading/demo skeleton
  # (components/admin/mockCustomers.tsx). Not real people.
  'grace.hopper@gmail.com'
  'multi.one@gmail.com'
  'multi.two@gmail.com'
  'multi.three@gmail.com'
)

# Env NAMES that must never appear in client output: their presence means an
# access-control module got bundled for the browser, which also discloses the
# gating mechanism.
BANNED_NAMES=( 'ADMIN_EMAIL' 'ALLOWLIST' )

# Email-shaped tokens on these domains/prefixes are treated as identities.
EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

TARGETS=()
[ -d "$ROOT/.next/static" ]     && TARGETS+=("$ROOT/.next/static")
[ -d "$ROOT/chrome-extension" ] && TARGETS+=("$ROOT/chrome-extension")

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "check-no-identities: no client output to scan (.next/static missing — run 'bun run build' first)"
  echo "check-no-identities: REFUSING to pass without scanning anything"
  exit 1
fi

echo "check-no-identities: scanning ${TARGETS[*]}"
fail=0

# ── 1. Identity-shaped tokens ───────────────────────────────────────────────
# -I skips binaries (images/fonts). Collect unique matches, then subtract ALLOWED.
found_emails=$(grep -rIhoE "$EMAIL_RE" "${TARGETS[@]}" 2>/dev/null | sort -u || true)
leaked=""
while IFS= read -r addr; do
  [ -z "$addr" ] && continue
  ok=0
  for a in "${ALLOWED[@]}"; do
    [ "$addr" = "$a" ] && { ok=1; break; }
  done
  # Only flag addresses on domains we actually care about; a bundled third-party
  # library's author email (e.g. in a license header) is noise, not our identity.
  case "$addr" in
    *@computercaller.com|*@gmail.com|reviewer@*|playstore-reviewer@*|dennis@*) ;;
    *) ok=1 ;;
  esac
  [ "$ok" -eq 0 ] && leaked="$leaked$addr"$'\n'
done <<< "$found_emails"

if [ -n "$leaked" ]; then
  fail=1
  echo "ERROR: personal identity address(es) in client output:"
  echo "$leaked" | sed '/^$/d;s/^/  /'
  echo "  (files:)"
  while IFS= read -r addr; do
    [ -z "$addr" ] && continue
    grep -rIlF "$addr" "${TARGETS[@]}" 2>/dev/null | sed 's/^/    /'
  done <<< "$leaked"
fi

# ── 2. Access-control env names ─────────────────────────────────────────────
for name in "${BANNED_NAMES[@]}"; do
  hits=$(grep -rIlF "$name" "${TARGETS[@]}" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    fail=1
    echo "ERROR: access-control env name '$name' in client output:"
    echo "$hits" | sed 's/^/  /'
  fi
done

if [ "$fail" -ne 0 ]; then
  cat <<'MSG'

An identity string or an access-control env NAME reached a PUBLIC client bundle.
Anything in .next/static is fetchable by anyone, unauthenticated.

Usual cause: a 'use client' module imported a server module (directly or through
a re-export chain). Trace it with:
  grep -rn "from '@/lib/<module>'" components/ hooks/ app/
Fix by splitting the value the client needs into a dependency-free module (see
lib/nextPath.ts for the worked example), NOT by widening ALLOWED above.
MSG
  exit 1
fi

echo "check-no-identities: OK — no personal identities, no access-control env names in client output"
