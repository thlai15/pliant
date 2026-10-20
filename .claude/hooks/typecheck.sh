#!/usr/bin/env bash
# Runs tsc --noEmit after any .ts file in src/ is edited.
# Exits 1 with error output so Claude sees and fixes type errors immediately.
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" != *.ts ]] && exit 0
HOOK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$FILE" != "$HOOK_ROOT"/src/* ]] && exit 0

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

OUTPUT=$(cd "$PROJ" && npx tsc --noEmit 2>&1)
if [ -n "$OUTPUT" ]; then
  {
    echo "=== TypeScript errors ==="
    echo "$OUTPUT" | head -50
  } >&2
  exit 2
fi
