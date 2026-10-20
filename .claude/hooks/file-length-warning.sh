#!/usr/bin/env bash
# Advisory warning when a .ts file exceeds 300 lines (project rule: split responsibilities).
# Always exits 0 — this is a nudge, not a blocker.
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" != *.ts ]] && exit 0
[ ! -f "$FILE" ] && exit 0

LINES=$(wc -l < "$FILE")
if [ "$LINES" -gt 300 ]; then
  echo "WARNING: $(basename "$FILE") is $LINES lines (>300). Consider whether it has grown beyond a single responsibility."
fi
