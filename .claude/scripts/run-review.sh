#!/usr/bin/env bash
# Core review script. Loads full codebase context + KB, calls claude -p, saves output.
# Usage: run-review.sh [base-branch]   (default: main)
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_DIR="$PROJ/.claude"
KB="$CLAUDE_DIR/review-kb.json"
RULES_DIR="$CLAUDE_DIR/rules"
BASE_BRANCH="${1:-main}"

# ── Resolve base branch ──────────────────────────────────────────────────────
if ! git -C "$PROJ" rev-parse "$BASE_BRANCH" &>/dev/null; then
  BASE_BRANCH="HEAD~1"
fi

DIFF=$(git -C "$PROJ" diff "$BASE_BRANCH"...HEAD 2>/dev/null)
if [ -z "$DIFF" ]; then
  DIFF=$(git -C "$PROJ" diff HEAD~1 2>/dev/null)
fi

if [ -z "$DIFF" ]; then
  echo "No diff found against $BASE_BRANCH. Nothing to review."
  exit 0
fi

DIFF_HASH=$(echo "$DIFF" | md5sum | cut -d' ' -f1)
BRANCH=$(git -C "$PROJ" branch --show-current 2>/dev/null || echo "detached")
DATE=$(date +%Y-%m-%d)

echo "Running review for branch '$BRANCH' (diff: ${DIFF_HASH:0:8})..."

# ── Load KB context ──────────────────────────────────────────────────────────
SUPPRESSIONS=""
if [ -f "$KB" ]; then
  SUPPRESSIONS=$(jq -r '
    .suppressions[]? |
    "- " + .pattern + " (reason: " + .reason + ")"
  ' "$KB" 2>/dev/null || echo "")

  PATTERNS=$(jq -r '
    .patterns[]? |
    "- [" + .severity + "] " + .description +
    (if .occurrences then " (seen " + (.occurrences|tostring) + " times)" else "" end)
  ' "$KB" 2>/dev/null || echo "")

  HIGH_RISK=$(jq -r '.high_risk_areas[]? | "- " + .' "$KB" 2>/dev/null || echo "")
fi

# ── Load changed files in full ───────────────────────────────────────────────
CHANGED_FILES=$(git -C "$PROJ" diff "$BASE_BRANCH"...HEAD --name-only 2>/dev/null \
  | grep -E "^src/.*\.ts$" || true)

FILE_CONTENTS=""
for f in $CHANGED_FILES; do
  full="$PROJ/$f"
  if [ -f "$full" ]; then
    FILE_CONTENTS+="### $f"$'\n'
    FILE_CONTENTS+='```typescript'$'\n'
    FILE_CONTENTS+=$(cat "$full")
    FILE_CONTENTS+=$'\n''```'$'\n\n'
  fi
done

# ── Build prompt ─────────────────────────────────────────────────────────────
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

cat > "$TMPFILE" << PROMPT
You are a senior code reviewer for the Pliant project — a plan-driven, self-healing test
execution framework built in TypeScript. Your job is to find real problems: bugs, security
vulnerabilities, rule violations, and missing error handling. Do not flag style issues
already enforced by the project's existing hooks.

━━ PROJECT RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## TypeScript Rules
$(cat "$RULES_DIR/typescript.md" 2>/dev/null)

## Architecture Rules
$(cat "$RULES_DIR/architecture.md" 2>/dev/null)

## LLM Interface Rules
$(cat "$RULES_DIR/llm-interface.md" 2>/dev/null)

## Testing Rules
$(cat "$RULES_DIR/testing.md" 2>/dev/null)

━━ KNOWLEDGE BASE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Do NOT re-raise these (previously dismissed as false-positive or intentional):
${SUPPRESSIONS:-"(none yet)"}

## Known recurring patterns to watch for:
${PATTERNS:-"(none yet)"}

## High-risk areas in this codebase:
${HIGH_RISK:-"(none yet)"}

━━ CHANGED FILES (FULL CONTENT) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${FILE_CONTENTS:-"(no .ts files in src/ changed)"}

━━ DIFF ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

\`\`\`diff
$DIFF
\`\`\`

━━ OUTPUT FORMAT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY a valid JSON object. No markdown fences, no preamble, no explanation.

{
  "summary": "<2-3 sentences: what changed and the most important concern>",
  "findings": [
    {
      "id": <integer starting at 1>,
      "severity": "critical" | "high" | "medium" | "low",
      "file": "<repo-relative path or null>",
      "line": <integer or null>,
      "title": "<under 80 chars>",
      "description": "<specific explanation of the problem>",
      "suggested_fix": "<concrete actionable fix>"
    }
  ]
}

Severity guide:
  critical — data loss, crash, security vulnerability, breaks core contract
  high     — logic bug, rule violation with real impact, missing required error handling
  medium   — incomplete handling, test gap, fragile assumption
  low      — informational, minor improvement
PROMPT

# ── Call claude -p ───────────────────────────────────────────────────────────
RESULT=$(claude -p "$(cat "$TMPFILE")" 2>&1)

# ── Validate JSON ────────────────────────────────────────────────────────────
if ! echo "$RESULT" | jq . > /dev/null 2>&1; then
  echo "WARNING: claude returned non-JSON. Saving raw output."
  {
    echo "# Pliant Code Review (raw)"
    echo "**Date:** $DATE  **Branch:** $BRANCH"
    echo ""
    echo "$RESULT"
  } > "$CLAUDE_DIR/last-review.md"
  echo "$DIFF_HASH" > "$CLAUDE_DIR/.last-review-hash"
  echo "Review saved to .claude/last-review.md"
  exit 0
fi

# ── Save JSON findings ───────────────────────────────────────────────────────
echo "$RESULT" > "$CLAUDE_DIR/last-review.json"

# ── Render markdown ──────────────────────────────────────────────────────────
FINDING_COUNT=$(echo "$RESULT" | jq '.findings | length')

{
  echo "# Pliant Code Review"
  echo "**Date:** $DATE  **Branch:** $BRANCH  **Findings:** $FINDING_COUNT"
  echo ""
  echo "## Summary"
  echo "$RESULT" | jq -r '.summary'
  echo ""

  for severity in critical high medium low; do
    case $severity in
      critical) icon="🔴 CRITICAL" ;;
      high)     icon="🟠 HIGH" ;;
      medium)   icon="🟡 MEDIUM" ;;
      low)      icon="🟢 LOW" ;;
    esac

    ITEMS=$(echo "$RESULT" | jq -r \
      --arg sev "$severity" \
      '.findings[] | select(.severity == $sev) |
       "### '"$icon"' — id:\(.id) — \(if .file then "`\(.file)\(if .line then ":\(.line)" else "" end)`" else "(general)" end) — \(.title)\n\(.description)\n\n**Fix:** \(.suggested_fix)\n"' \
      2>/dev/null)

    if [ -n "$ITEMS" ]; then
      echo "## $icon"
      echo ""
      echo "$ITEMS"
    fi
  done
} > "$CLAUDE_DIR/last-review.md"

# ── Store diff hash ──────────────────────────────────────────────────────────
echo "$DIFF_HASH" > "$CLAUDE_DIR/.last-review-hash"

# ── Update review stats in KB ────────────────────────────────────────────────
if [ -f "$KB" ]; then
  UPDATED=$(jq \
    --argjson count "$FINDING_COUNT" \
    '.stats.total_reviews += 1 | .stats.total_findings += $count' \
    "$KB")
  echo "$UPDATED" > "$KB"
fi

echo "Review complete: $FINDING_COUNT finding(s) — see .claude/last-review.md"
echo "Run 'npm run review:feedback' to log outcomes to the knowledge base."
