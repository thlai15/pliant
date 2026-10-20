#!/usr/bin/env bash
# Enforces the import direction rules from docs/architecture.md.
# Scans all of src/ on every .ts edit — a violation anywhere breaks the build.
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" != *.ts ]] && exit 0
HOOK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$FILE" != "$HOOK_ROOT"/src/* ]] && exit 0

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VIOLATIONS=()

# Helper: grep imports in a directory for a forbidden target (alias or relative)
check_imports() {
  local src_dir="$1" forbidden_alias="$2" forbidden_rel="$3" label="$4"
  while IFS= read -r match; do
    VIOLATIONS+=("$label: $match")
  done < <(grep -rn "from ['\"]$forbidden_alias\|from ['\"]$forbidden_rel" \
    "$PROJ/src/$src_dir/" 2>/dev/null | grep -v '\.gitkeep\|\.d\.ts')
}

# Rule: locator/ must not import from runner/
check_imports "locator" "@runner" "\.\./runner" "LOCATOR→RUNNER"

# Rule: llm/ must not import from runner/, locator/, or report/
check_imports "llm" "@runner"   "\.\./runner"  "LLM→RUNNER"
check_imports "llm" "@locator"  "\.\./locator" "LLM→LOCATOR"
check_imports "llm" "@report"   "\.\./report"  "LLM→REPORT"

# Rule: parser/ must not import from runner/, locator/, llm/, or report/
check_imports "parser" "@runner"  "\.\./runner"  "PARSER→RUNNER"
check_imports "parser" "@locator" "\.\./locator" "PARSER→LOCATOR"
check_imports "parser" "@llm"     "\.\./llm"     "PARSER→LLM"
check_imports "parser" "@report"  "\.\./report"  "PARSER→REPORT"

# Rule: report/ must not import from runner/
check_imports "report" "@runner"  "\.\./runner"  "REPORT→RUNNER"

# Rule: only PlanRunner.ts may import ClaudeClient or OllamaClient
while IFS= read -r line; do
  src_file=$(echo "$line" | cut -d: -f1)
  [[ "$src_file" == */PlanRunner.ts ]] && continue
  [[ "$src_file" == */ClaudeClient.ts ]] && continue
  [[ "$src_file" == */OllamaClient.ts ]] && continue
  VIOLATIONS+=("DIRECT-LLM-IMPORT (only PlanRunner may use concrete clients): $line")
done < <(grep -rn "import.*ClaudeClient\|import.*OllamaClient" "$PROJ/src/" 2>/dev/null \
  | grep -v '\.gitkeep\|\.d\.ts')

# Rule: only the concrete driver may import a browser library
while IFS= read -r line; do
  src_file=$(echo "$line" | cut -d: -f1)
  [[ "$src_file" == */driver/PlaywrightDriver.ts ]] && continue
  VIOLATIONS+=("DIRECT-BROWSER-IMPORT (use BrowserDriver; only PlaywrightDriver may import Playwright): $line")
done < <(grep -rnE "from ['\"](@playwright/test|playwright(-core)?)['\"]" "$PROJ/src/" 2>/dev/null \
  | grep -v '\.gitkeep\|\.d\.ts')

# Rule: only PlanRunner.ts may import a concrete driver
while IFS= read -r line; do
  src_file=$(echo "$line" | cut -d: -f1)
  [[ "$src_file" == */PlanRunner.ts ]] && continue
  [[ "$src_file" == */driver/PlaywrightDriver.ts ]] && continue
  VIOLATIONS+=("DIRECT-DRIVER-IMPORT (only PlanRunner may use concrete drivers): $line")
done < <(grep -rn "import.*PlaywrightDriver" "$PROJ/src/" 2>/dev/null \
  | grep -v '\.gitkeep\|\.d\.ts')

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  {
    echo "=== Architecture boundary violations ==="
    printf '  %s\n' "${VIOLATIONS[@]}"
  } >&2
  exit 2
fi
