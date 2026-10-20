#!/usr/bin/env bash
# Interactive CLI for logging review outcomes to the knowledge base.
# Reads .claude/last-review.json, asks for outcome on each finding,
# writes results to review-kb.json, then checks if compression is needed.
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_DIR="$PROJ/.claude"
KB="$CLAUDE_DIR/review-kb.json"
REVIEW_JSON="$CLAUDE_DIR/last-review.json"

if [ ! -f "$REVIEW_JSON" ]; then
  echo "No review found. Run 'npm run review' first."
  exit 1
fi

FINDING_COUNT=$(jq '.findings | length' "$REVIEW_JSON")
if [ "$FINDING_COUNT" -eq 0 ]; then
  echo "No findings in last review. Nothing to log."
  exit 0
fi

BRANCH=$(git -C "$PROJ" branch --show-current 2>/dev/null || echo "unknown")
DATE=$(date +%Y-%m-%dT%H:%M:%SZ)

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Review Feedback — $BRANCH"
echo "  $FINDING_COUNT finding(s) to triage"
echo "═══════════════════════════════════════════════════"
echo ""

NEW_FINDINGS="[]"

for i in $(seq 0 $((FINDING_COUNT - 1))); do
  FINDING=$(jq ".findings[$i]" "$REVIEW_JSON")
  ID=$(echo "$FINDING" | jq -r '.id')
  SEVERITY=$(echo "$FINDING" | jq -r '.severity' | tr '[:lower:]' '[:upper:]')
  FILE=$(echo "$FINDING" | jq -r 'if .file then .file + (if .line then ":\(.line)" else "" end) else "(general)" end')
  TITLE=$(echo "$FINDING" | jq -r '.title')
  DESC=$(echo "$FINDING" | jq -r '.description')
  FIX=$(echo "$FINDING" | jq -r '.suggested_fix')

  case $(echo "$FINDING" | jq -r '.severity') in
    critical) BADGE="🔴" ;;
    high)     BADGE="🟠" ;;
    medium)   BADGE="🟡" ;;
    low)      BADGE="🟢" ;;
    *)        BADGE="⚪" ;;
  esac

  echo "──────────────────────────────────────────────────"
  echo "$BADGE [$SEVERITY] #$ID — $FILE"
  echo "   $TITLE"
  echo ""
  echo "   $DESC"
  echo ""
  echo "   Fix: $FIX"
  echo ""

  while true; do
    printf "  Outcome — (f)ixed  (d)ismissed  (p)false-positive  (s)kip: "
    read -r CHOICE </dev/tty

    case "$CHOICE" in
      f|fixed)
        OUTCOME="fixed"
        break ;;
      d|dismissed)
        OUTCOME="dismissed"
        break ;;
      p|false-positive|fp)
        OUTCOME="false-positive"
        printf "  Suppression note (why this is a false-positive): "
        read -r NOTE </dev/tty
        # Add to suppressions
        SUPPRESSION=$(jq -n \
          --arg pattern "$TITLE" \
          --arg reason "${NOTE:-marked false-positive on $DATE}" \
          --arg file "$FILE" \
          '{"pattern": $pattern, "reason": $reason, "file": $file}')
        UPDATED=$(jq --argjson s "$SUPPRESSION" '.suppressions += [$s]' "$KB")
        echo "$UPDATED" > "$KB"
        echo "  ✓ Suppression added — won't be raised again."
        break ;;
      s|skip)
        OUTCOME="skipped"
        break ;;
      *)
        echo "  Please enter f, d, p, or s."
        ;;
    esac
  done

  echo ""

  if [ "$OUTCOME" != "skipped" ] && [ "$OUTCOME" != "false-positive" ]; then
    ENTRY=$(jq -n \
      --arg branch "$BRANCH" \
      --arg date "$DATE" \
      --argjson finding "$FINDING" \
      --arg outcome "$OUTCOME" \
      '{
        "branch": $branch,
        "date": $date,
        "id": $finding.id,
        "severity": $finding.severity,
        "file": ($finding.file // null),
        "line": ($finding.line // null),
        "title": $finding.title,
        "outcome": $outcome
      }')
    NEW_FINDINGS=$(echo "$NEW_FINDINGS" | jq --argjson e "$ENTRY" '. += [$e]')
  fi
done

# ── Write all outcomes to KB in one pass ─────────────────────────────────────
if [ "$(echo "$NEW_FINDINGS" | jq 'length')" -gt 0 ]; then
  UPDATED=$(jq --argjson nf "$NEW_FINDINGS" '.recent_findings += $nf' "$KB")
  echo "$UPDATED" > "$KB"
fi

echo "═══════════════════════════════════════════════════"
echo "  Feedback saved to .claude/review-kb.json"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Trigger compression if KB is large enough ─────────────────────────────────
ENTRY_COUNT=$(jq '.recent_findings | length' "$KB")
KB_SIZE=$(wc -c < "$KB")

if [ "$ENTRY_COUNT" -gt 200 ] || [ "$KB_SIZE" -gt 51200 ]; then
  echo "Knowledge base has $ENTRY_COUNT entries ($(( KB_SIZE / 1024 ))KB) — compressing..."
  bash "$(dirname "${BASH_SOURCE[0]}")/compress-kb.sh"
fi
