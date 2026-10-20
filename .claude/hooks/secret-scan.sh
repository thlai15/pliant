#!/usr/bin/env bash
# Scans the edited file for hardcoded secrets and API key literals.
# Fires on any file type — secrets can appear in .ts, .json, .md, .yaml, etc.
# Skips .env files (expected to hold values) and .env.example (documentation).
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" == */.env ]] && exit 0
[[ "$FILE" == */.env.example ]] && exit 0
[[ "$FILE" == */node_modules/* ]] && exit 0
[ ! -f "$FILE" ] && exit 0

VIOLATIONS=()

# Anthropic API key literals (sk-ant-api03-...)
while IFS= read -r match; do
  VIOLATIONS+=("Hardcoded Anthropic API key: $match")
done < <(grep -n "sk-ant-api[0-9]*-" "$FILE" | grep -v "process\.env\|^\s*//" )

# Generic: apiKey, api_key, token, password assigned to a string literal (not env var)
while IFS= read -r match; do
  VIOLATIONS+=("Possible hardcoded secret (use process.env): $match")
done < <(grep -Ein "(api[_-]?key|token|password|secret)[[:space:]]*[=:][[:space:]]*['\"][^'\"]{8,}" "$FILE" \
  | grep -iv "process\.env\|placeholder\|example\|your[_-]\|<your\|TODO\|FIXME\|test\|mock\|dummy\|describe\|it(" \
  | grep -v "^\s*//")

# Bearer token literals with substantial length (not a variable reference)
while IFS= read -r match; do
  VIOLATIONS+=("Hardcoded Bearer token: $match")
done < <(grep -in "Bearer [a-zA-Z0-9_\-\.]{20,}" "$FILE" | grep -v "process\.env\|^\s*//")

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  {
    echo "=== Potential secrets in $(basename "$FILE") — do not commit ==="
    printf '  %s\n' "${VIOLATIONS[@]}"
  } >&2
  exit 2
fi
