#!/usr/bin/env bash
# Guard: Chrome refuses to load an unpacked extension containing any file or
# directory whose name starts with "_" (reserved for the system).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/chrome-extension"
[ -d "$EXT" ] || { echo "check-extension: no chrome-extension/ dir, skipping"; exit 0; }

bad=$(find "$EXT" -name '_*' -not -path '*/node_modules/*' || true)
if [ -n "$bad" ]; then
  echo "ERROR: '_'-prefixed names are reserved by Chrome and break 'Load unpacked':"
  echo "$bad"
  echo "Rename them, or move non-shipped sources to design/ instead."
  exit 1
fi

# Guard (2026-09-15): the private key that pins the extension ID must NEVER sit
# inside the shipped/unpacked dir — Chrome warns on load and a Web Store zip
# would leak it. It lives at C:/Users/D/Keystores/computercaller-extension-key.pem
# (see niki/PROJECTS/computercaller/CREDS.md). The ID stays pinned by the
# manifest "key" field, not by the file.
secrets=$(find "$EXT" \( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \) -not -path '*/node_modules/*' || true)
if [ -n "$secrets" ]; then
  echo "ERROR: private key material inside chrome-extension/ (move it to C:/Users/D/Keystores/):"
  echo "$secrets"
  exit 1
fi

[ -f "$EXT/manifest.json" ] || { echo "ERROR: chrome-extension/manifest.json missing"; exit 1; }
grep -q '"manifest_version"' "$EXT/manifest.json"   || { echo "ERROR: manifest.json missing manifest_version"; exit 1; }

echo "check-extension: OK"

# Guard (2026-09-17, dispatch forge/w-strip-email-literals): no personal email
# or access-control env NAME may ship in the unpacked extension or any public
# client bundle. See tools/check-no-identities.sh for the incident this closes.
bash "$ROOT/tools/check-no-identities.sh"
