#!/usr/bin/env bash
# Maps edited source files to their test directory and runs the relevant unit tests.
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ "$FILE" != *.ts ]] && exit 0
[[ "$FILE" != */pliant/src/* ]] && exit 0

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR=""

case "$FILE" in
  */src/parser/*)               TEST_DIR="tests/unit/parser/" ;;
  */src/locator/*)              TEST_DIR="tests/unit/locator/" ;;
  */src/runner/BusinessRuleEvaluator.ts) TEST_DIR="tests/unit/evaluator/" ;;
  */src/runner/StepScheduler.ts)         TEST_DIR="tests/unit/scheduler/" ;;
  */src/llm/prompts/*)          TEST_DIR="tests/unit/prompts/" ;;
  */src/report/*)               TEST_DIR="tests/unit/report/" ;;
esac

[ -z "$TEST_DIR" ] && exit 0

# Skip if no test files exist in the target directory yet
TEST_FILES=$(find "$PROJ/$TEST_DIR" -name "*.test.ts" 2>/dev/null)
[ -z "$TEST_FILES" ] && exit 0

echo "=== Running tests: $TEST_DIR ==="
OUTPUT=$(cd "$PROJ" && npx playwright test "$TEST_DIR" --reporter=line 2>&1)
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "$OUTPUT" | tail -40 >&2
  exit 2
fi

echo "$OUTPUT" | tail -40
