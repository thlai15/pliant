#!/usr/bin/env bash
# Validates files in src/llm/prompts/ against the LLMPrompt contract:
#   - must export a function
#   - must return an object with system and user fields
#   - system prompt must instruct the model to return JSON only
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" != */pliant/src/llm/prompts/*.ts ]] && exit 0
[[ "$FILE" == *.d.ts ]] && exit 0
[ ! -f "$FILE" ] && exit 0

VIOLATIONS=()

if ! grep -qE "^export (function|const [A-Za-z]+ =)" "$FILE" 2>/dev/null; then
  VIOLATIONS+=("No exported function found — each prompt file must export a typed function")
fi

if ! grep -q "system:" "$FILE" 2>/dev/null; then
  VIOLATIONS+=("Missing 'system:' field — return value must include LLMPrompt.system")
fi

if ! grep -q "user:" "$FILE" 2>/dev/null; then
  VIOLATIONS+=("Missing 'user:' field — return value must include LLMPrompt.user")
fi

if ! grep -qi "JSON" "$FILE" 2>/dev/null; then
  VIOLATIONS+=("System prompt should instruct the model to 'Return a JSON object only' (per llm-interface.md)")
fi

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  {
    echo "=== Prompt shape issues in $(basename "$FILE") ==="
    printf '  %s\n' "${VIOLATIONS[@]}"
  } >&2
  exit 2
fi
