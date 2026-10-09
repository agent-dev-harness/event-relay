#!/usr/bin/env bash
# The single merge gate. CI workflows only install Node and call this, so the
# gate is the same locally and in CI and can't drift between workflows.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "=== npm ci (runs prepare: build) ==="
npm ci --no-audit --no-fund
echo "=== lint: tsc, ESLint, check-explicit-any, boundary guard ==="
npm run lint
echo "=== build ==="
npm run build
echo "=== test ==="
npm test
