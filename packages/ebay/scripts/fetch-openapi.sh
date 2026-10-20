#!/usr/bin/env bash
# Downloads the Browse OpenAPI file for the manual conformance check (pnpm openapi:check).
# The file itself is never committed (ADR 0023); its URL, version and SHA-256 are, in
# openapi/browse.lock.json. eBay serves the file from an unversioned URL, so a hash mismatch
# means eBay published a new spec: review the fields we use, then update the lock.
set -euo pipefail

cd "$(dirname "$0")/.."
lock=openapi/browse.lock.json
target=.openapi/buy_browse_v1_oas3.json

url=$(node -p "require('./$lock').url")
expected=$(node -p "require('./$lock').sha256")

mkdir -p .openapi
curl -fsSL -o "$target" "$url"

actual=$(shasum -a 256 "$target" | cut -d ' ' -f 1)
if [[ "$actual" != "$expected" ]]; then
  echo "upstream spec changed, review and update the lock (expected $expected, got $actual)" >&2
  exit 1
fi
echo "Browse OpenAPI file matches the lock ($expected)"
