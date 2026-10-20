#!/usr/bin/env bash
# Checks the edited src/ file for rule violations that ESLint alone won't catch:
#   - console.log          (must use logger wrapper)
#   - process.env          (only allowed in PlanRunner.ts)
#   - 'any' type           (must use unknown + type guard)
#   - magic numbers        (must be named constants)
#   - ! non-null assertion (must use type guards)
#   - readFileSync/writeFileSync (must use fs/promises)
#   - deep relative imports ../../ (must use @alias paths)
#   - inline prompt strings outside src/llm/prompts/ (must be in prompts/)
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" != *.ts ]] && exit 0
HOOK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$FILE" != "$HOOK_ROOT"/src/* ]] && exit 0
[ ! -f "$FILE" ] && exit 0

VIOLATIONS=()

# console.log — use logger wrapper from src/types/logger.ts
while IFS= read -r match; do
  VIOLATIONS+=("console.log (use logger): $match")
done < <(grep -n "console\.log" "$FILE" | grep -v "^\s*//" | cut -d: -f1,3-)

# process.env — only PlanRunner.ts may read env vars
if [[ "$FILE" != */PlanRunner.ts ]]; then
  while IFS= read -r match; do
    VIOLATIONS+=("process.env (only PlanRunner.ts may read env): $match")
  done < <(grep -n "process\.env" "$FILE" | grep -v "^\s*//" | cut -d: -f1,3-)
fi

# 'any' type — use unknown + type guard
while IFS= read -r match; do
  VIOLATIONS+=("'any' type forbidden, use unknown: $match")
done < <(grep -n ": any\b\|as any\b\|<any>" "$FILE" | grep -v "^\s*//" | cut -d: -f1,3-)

# Magic threshold numbers — must be named constants in src/types/constants.ts
if [[ "$FILE" != */constants.ts ]]; then
  while IFS= read -r match; do
    VIOLATIONS+=("magic number (define in constants.ts): $match")
  done < <(grep -n "\b0\.\(75\|40\|50\)\b" "$FILE" | grep -v "^\s*//" | cut -d: -f1,3-)
fi

# ! non-null assertion — use type guards instead
while IFS= read -r match; do
  VIOLATIONS+=("! non-null assertion forbidden, use a type guard: $match")
done < <(grep -En "[a-zA-Z0-9_\]\)]!" "$FILE" | grep -Ev "!=" | grep -v "^\s*//" | cut -d: -f1,3-)

# readFileSync / writeFileSync — use fs/promises in the execution path
while IFS= read -r match; do
  VIOLATIONS+=("Sync file I/O forbidden, use fs/promises: $match")
done < <(grep -n "readFileSync\|writeFileSync\|existsSync\|mkdirSync" "$FILE" | grep -v "^\s*//" | cut -d: -f1,3-)

# Deep relative imports (../../) — use @alias paths defined in tsconfig
while IFS= read -r match; do
  VIOLATIONS+=("Deep relative import (use @alias path from tsconfig): $match")
done < <(grep -En "from ['\"](\.\./){2}" "$FILE" | grep -v "^\s*//" | cut -d: -f1,3-)

# Inline prompt strings outside src/llm/prompts/ — must live in prompts/ files
if [[ "$FILE" != */llm/prompts/* ]]; then
  while IFS= read -r match; do
    VIOLATIONS+=("Inline prompt string (move to src/llm/prompts/): $match")
  done < <(grep -n "system:[[:space:]]*['\"\`]" "$FILE" | grep -v "^\s*//" | cut -d: -f1,3-)
fi

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  {
    echo "=== Hygiene violations in $(basename "$FILE") ==="
    printf '  %s\n' "${VIOLATIONS[@]}"
  } >&2
  exit 2
fi
