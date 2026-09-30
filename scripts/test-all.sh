#!/usr/bin/env bash
# Every check in the repository: the shared-file guard, the Node example, each Cloudflare preset, the docs MCP.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/sync-check.mjs
npm test

for preset in cloudflare-*/; do
  [ -f "$preset/package.json" ] || continue
  echo "== $preset"
  (cd "$preset" && npm ci && npm test && npx wrangler deploy --dry-run)
done

if [ -f packages/docs-mcp/package.json ]; then
  echo "== packages/docs-mcp"
  (cd packages/docs-mcp && npm ci && npm test)
fi
