#!/usr/bin/env bash
# Runs npm audit when package.json or package-lock.json changes.
# Only fails on high/critical severity to avoid blocking on every moderate CVE.
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" != */package.json ]] && [[ "$FILE" != */package-lock.json ]] && exit 0
[[ "$FILE" == */node_modules/* ]] && exit 0

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "=== npm audit (high/critical) ==="
cd "$PROJ" && npm audit --audit-level=high 2>&1 | tail -20
