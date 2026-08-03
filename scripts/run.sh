#!/usr/bin/env bash
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "=== TEST ==="
pnpm --filter @open-agent-tools/cli test 2>&1 | tail -40
echo "=== TYPECHECK ==="
pnpm --filter @open-agent-tools/cli typecheck 2>&1 | tail -30