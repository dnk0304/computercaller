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

[ -f "$EXT/manifest.json" ] || { echo "ERROR: chrome-extension/manifest.json missing"; exit 1; }
grep -q '"manifest_version"' "$EXT/manifest.json"   || { echo "ERROR: manifest.json missing manifest_version"; exit 1; }

echo "check-extension: OK"
