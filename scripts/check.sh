#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
node scripts/pack-check.mjs
if [[ -z "${ASSAY_V014_CLI:-}" ]]; then
  if [[ -n "${CI:-}" ]]; then
    echo "CI requires ASSAY_V014_CLI to point to the built v0.14.0 CLI" >&2
    exit 1
  fi
  echo "legacy-three-tool: local-only skip; set ASSAY_V014_CLI to run the frozen CLI contract"
elif [[ ! -f "$ASSAY_V014_CLI" ]]; then
  echo "legacy CLI is unavailable: $ASSAY_V014_CLI" >&2
  exit 1
else
  pnpm --filter own-work test -- legacy-three-tool.test.ts
fi
