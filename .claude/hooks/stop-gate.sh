#!/usr/bin/env bash
# Stop-gate: before Claude's turn is allowed to end, re-runs every check
# (secrets, hygiene, prompt shape, typecheck, architecture boundaries, unit
# tests) against every .ts file changed since the base branch — committed,
# staged, unstaged, or untracked. Blocks (exit 2) with the collected failures
# until everything passes.
#
# Reuses the individual PostToolUse hook scripts directly (feeding them fake
# tool_input JSON) rather than re-implementing their check logic here.
#
# Loop safety: Claude Code auto-releases a Stop hook after 8 consecutive
# blocks regardless of what this script does (see stop_hook_active in the
# hooks docs). We additionally give up after our own MAX_ATTEMPTS and let
# Claude stop with a warning, so a check that can never pass (flaky test,
# pre-existing failure, bug in the checker) doesn't silently burn that whole
# budget.
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "default"' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="default"

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_DIR="$PROJ/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
COUNTER_FILE="$CLAUDE_DIR/.stop-gate-attempts-$SESSION_ID"
MAX_ATTEMPTS=3

BASE_BRANCH="main"
git -C "$PROJ" rev-parse "$BASE_BRANCH" &>/dev/null || BASE_BRANCH="HEAD~1"

CHANGED=$( {
  git -C "$PROJ" diff --name-only --diff-filter=ACMR "$BASE_BRANCH"...HEAD -- '*.ts' 2>/dev/null
  git -C "$PROJ" diff --name-only --diff-filter=ACMR HEAD -- '*.ts' 2>/dev/null
  git -C "$PROJ" ls-files --others --exclude-standard -- '*.ts' 2>/dev/null
} | grep '^src/' | sort -u )

if [ -z "$CHANGED" ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

VIOLATIONS=()

run_hook_on_file() {
  local script="$1" abs_file="$2"
  local out status
  out=$(echo "{\"tool_input\":{\"file_path\":\"$abs_file\"}}" | bash "$HOOKS_DIR/$script" 2>&1)
  status=$?
  [ "$status" -ne 0 ] && VIOLATIONS+=("── $script: $(basename "$abs_file") ──"$'\n'"$out")
}

run_hook_once() {
  local script="$1"
  local dummy="$PROJ/src/__stop_gate_dummy__.ts"
  local out status
  out=$(echo "{\"tool_input\":{\"file_path\":\"$dummy\"}}" | bash "$HOOKS_DIR/$script" 2>&1)
  status=$?
  [ "$status" -ne 0 ] && VIOLATIONS+=("── $script (project-wide) ──"$'\n'"$out")
}

while IFS= read -r f; do
  [ -z "$f" ] && continue
  run_hook_on_file secret-scan.sh "$PROJ/$f"
  run_hook_on_file hygiene-check.sh "$PROJ/$f"
  run_hook_on_file prompt-shape-check.sh "$PROJ/$f"
done <<< "$CHANGED"

run_hook_once typecheck.sh
run_hook_once architecture-check.sh

if find "$PROJ/tests/unit" -name "*.test.ts" 2>/dev/null | grep -q .; then
  TEST_OUT=$(cd "$PROJ" && npx playwright test tests/unit --reporter=line 2>&1)
  [ $? -ne 0 ] && VIOLATIONS+=("── unit tests ──"$'\n'"$(echo "$TEST_OUT" | tail -40)")
fi

if [ ${#VIOLATIONS[@]} -eq 0 ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

ATTEMPTS=0
[ -f "$COUNTER_FILE" ] && ATTEMPTS=$(cat "$COUNTER_FILE")
ATTEMPTS=$((ATTEMPTS + 1))

if [ "$ATTEMPTS" -gt "$MAX_ATTEMPTS" ]; then
  {
    echo "Stop-gate: giving up after $MAX_ATTEMPTS blocked attempts — letting the turn end with unresolved issues below. Fix these manually:"
    printf '%s\n' "${VIOLATIONS[@]}"
  } >&2
  rm -f "$COUNTER_FILE"
  exit 0
fi

echo "$ATTEMPTS" > "$COUNTER_FILE"
{
  echo "Stop blocked (attempt $ATTEMPTS/$MAX_ATTEMPTS) — the following checks are still failing on changed files. Fix them before finishing:"
  printf '%s\n' "${VIOLATIONS[@]}"
} >&2
exit 2
