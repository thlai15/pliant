#!/usr/bin/env bash
# Stop hook: runs an LLM code review when Claude's turn ends, if there is a
# meaningful new diff since the last review — and blocks the turn (exit 2)
# when the review reports a critical or high severity finding, until the
# finding is resolved or an attempt cap is hit.
#
# Gates before invoking run-review.sh:
#   1. git diff vs main produces output
#   2. The diff is at least 15 lines changed (skip trivial edits)
#   3. Skip the (paid) LLM call if the diff hash matches the last review —
#      but still re-evaluate the cached findings for blocking, so leaving a
#      known critical/high finding unfixed doesn't bypass the gate.
#
# Loop safety: same attempt-cap pattern as stop-gate.sh, tracked in a
# separate counter file so a check-retry loop and a review-retry loop don't
# share a budget. Claude Code's own 8-consecutive-block cap is the backstop.
#
# Uses the project's existing rules/*.md files as the single source of truth
# for what "conforms to the architecture" means (loaded into the review
# prompt by run-review.sh) — no separate evaluator doc to keep in sync.
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "default"' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="default"

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_DIR="$PROJ/.claude"
HASH_FILE="$CLAUDE_DIR/.last-review-hash"
RESULT_FILE="$CLAUDE_DIR/last-review.json"
COUNTER_FILE="$CLAUDE_DIR/.review-gate-attempts-$SESSION_ID"
MAX_ATTEMPTS=3
BLOCKING_SEVERITIES="critical|high"

# Gate 1 + 2: diff exists and is non-trivial
BASE_BRANCH="main"
if ! git -C "$PROJ" rev-parse "$BASE_BRANCH" &>/dev/null 2>&1; then
  BASE_BRANCH="HEAD~1"
fi

DIFF=$(git -C "$PROJ" diff "$BASE_BRANCH"...HEAD 2>/dev/null)
if [ -z "$DIFF" ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

LINE_COUNT=$(echo "$DIFF" | wc -l)
if [ "$LINE_COUNT" -lt 15 ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

# Gate 3: only call the LLM again if the diff actually changed since the
# last review — but always re-evaluate whatever findings are on record.
DIFF_HASH=$(echo "$DIFF" | md5sum | cut -d' ' -f1)
NEEDS_RUN=1
if [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE")" = "$DIFF_HASH" ]; then
  NEEDS_RUN=0
fi

if [ "$NEEDS_RUN" -eq 1 ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  New changes detected — running code review..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  bash "$CLAUDE_DIR/scripts/run-review.sh" "$BASE_BRANCH"
fi

# Nothing to evaluate if there's no parseable JSON on record (e.g. the LLM
# call failed or returned non-JSON) — fail open rather than block forever
# on an infra problem.
if [ ! -f "$RESULT_FILE" ] || ! jq -e . "$RESULT_FILE" >/dev/null 2>&1; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

FINDINGS=$(jq -r --arg sev "$BLOCKING_SEVERITIES" '
  .findings[]? | select((.severity // "") | test("^(" + $sev + ")$"; "i")) |
  "[" + ((.severity // "unknown") | ascii_upcase) + "] " +
  (if .file then .file + (if .line then ":" + (.line|tostring) else "" end) + " — " else "" end) +
  (.title // "(no title)") + "\n  " + (.description // "") + "\n  Fix: " + (.suggested_fix // "n/a")
' "$RESULT_FILE" 2>&1)
JQ_STATUS=$?

if [ "$JQ_STATUS" -ne 0 ]; then
  echo "Review-gate: last-review.json parsed but had an unexpected shape (jq: $FINDINGS) — failing open, not blocking." >&2
  rm -f "$COUNTER_FILE"
  exit 0
fi

if [ -z "$FINDINGS" ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

ATTEMPTS=0
[ -f "$COUNTER_FILE" ] && ATTEMPTS=$(cat "$COUNTER_FILE")
ATTEMPTS=$((ATTEMPTS + 1))

if [ "$ATTEMPTS" -gt "$MAX_ATTEMPTS" ]; then
  {
    echo "Review-gate: giving up after $MAX_ATTEMPTS blocked attempts — letting the turn end with unresolved findings below. Fix these manually (see .claude/last-review.md):"
    echo "$FINDINGS"
  } >&2
  rm -f "$COUNTER_FILE"
  exit 0
fi

echo "$ATTEMPTS" > "$COUNTER_FILE"
{
  echo "Stop blocked by code review (attempt $ATTEMPTS/$MAX_ATTEMPTS) — critical/high findings must be resolved before finishing:"
  echo "$FINDINGS"
} >&2
exit 2
