#!/usr/bin/env bash
# PreToolUse guard: blocks Claude from writing to .env files.
# .env.example is allowed (it holds documentation values, not real secrets).
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
BASENAME=$(basename "$FILE")

[[ "$BASENAME" == .env.example ]] && exit 0
[[ "$BASENAME" == .env.*.example ]] && exit 0

if [[ "$BASENAME" == .env* ]]; then
  echo "BLOCKED: Writing to '$BASENAME' is not allowed via Claude."
  echo "Edit this file manually to prevent accidental secret exposure or overwrites."
  exit 1
fi
