#!/usr/bin/env bash
# Compresses the knowledge base when it grows too large.
# Distills recent_findings into durable patterns using claude -p,
# keeps the last 20 raw entries for recency context, discards the rest.
#
# Trigger thresholds (checked by feedback.sh, or run manually):
#   - recent_findings count > 200
#   - review-kb.json file size > 50KB
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KB="$PROJ/.claude/review-kb.json"

if [ ! -f "$KB" ]; then
  echo "No knowledge base found at .claude/review-kb.json"
  exit 1
fi

ENTRY_COUNT=$(jq '.recent_findings | length' "$KB")
echo "Compressing $ENTRY_COUNT findings into durable patterns..."

# ── Build compression prompt ─────────────────────────────────────────────────
ALL_FINDINGS=$(jq '.recent_findings' "$KB")
EXISTING_PATTERNS=$(jq '.patterns' "$KB")
EXISTING_SUPPRESSIONS=$(jq '.suppressions' "$KB")

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

cat > "$TMPFILE" << PROMPT
You are maintaining a code review knowledge base for the Pliant project.

Below are raw code review findings accumulated over multiple reviews.
Your job is to distill them into durable, reusable knowledge.

━━ EXISTING PATTERNS (already extracted — merge or extend, do not duplicate) ━━

$EXISTING_PATTERNS

━━ EXISTING SUPPRESSIONS ━━

$EXISTING_SUPPRESSIONS

━━ RAW FINDINGS TO COMPRESS ━━

$ALL_FINDINGS

━━ TASK ━━

Analyse the raw findings and produce:

1. patterns — recurring issue types that reviewers should watch for in future.
   Merge with existing patterns (increment occurrences, don't duplicate).
   Include only issues seen more than once OR high/critical severity issues.

2. suppressions — findings that were marked false-positive across multiple reviews,
   indicating a stable pattern that should never be re-raised.
   Merge with existing suppressions, do not duplicate.

3. high_risk_areas — file paths or component names that appear frequently in
   high/critical findings. Replace the existing list.

Return ONLY a valid JSON object. No markdown fences, no preamble.

{
  "patterns": [
    {
      "description": "<what the issue is and why it matters>",
      "severity": "critical" | "high" | "medium" | "low",
      "occurrences": <integer>,
      "example_file": "<most common file where this appears, or null>"
    }
  ],
  "suppressions": [
    {
      "pattern": "<short description matching the finding title>",
      "reason": "<why this is a false-positive or intentional in this project>",
      "file": "<file path or glob, or null for project-wide>"
    }
  ],
  "high_risk_areas": ["<file or component path>"]
}
PROMPT

# ── Call claude -p ───────────────────────────────────────────────────────────
RESULT=$(claude -p "$(cat "$TMPFILE")" 2>&1)

if ! echo "$RESULT" | jq . > /dev/null 2>&1; then
  echo "ERROR: claude returned non-JSON during compression. KB not modified."
  echo "Raw output:"
  echo "$RESULT" | head -20
  exit 1
fi

# ── Keep last 20 recent findings for recency context ─────────────────────────
RECENT_20=$(jq '.recent_findings | .[-20:]' "$KB")

# ── Rebuild KB with compressed data ─────────────────────────────────────────
NOW=$(date +%Y-%m-%dT%H:%M:%SZ)

UPDATED=$(jq \
  --argjson result "$RESULT" \
  --argjson recent "$RECENT_20" \
  --arg now "$NOW" \
  '
  .patterns         = $result.patterns +
                      ($result.suppressions | map(select(. == null)) // []) |
  .patterns         = $result.patterns |
  .suppressions     = $result.suppressions |
  .high_risk_areas  = $result.high_risk_areas |
  .recent_findings  = $recent |
  .stats.last_compressed_at = $now |
  .stats.compression_count += 1
  ' "$KB")

echo "$UPDATED" > "$KB"

NEW_COUNT=$(jq '.recent_findings | length' "$KB")
PATTERN_COUNT=$(jq '.patterns | length' "$KB")
echo "Compression complete:"
echo "  Patterns extracted: $PATTERN_COUNT"
echo "  Recent findings kept: $NEW_COUNT (last 20)"
echo "  Discarded: $((ENTRY_COUNT - NEW_COUNT)) raw entries"
