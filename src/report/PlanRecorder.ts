import { writeFile } from 'fs/promises'
import * as path from 'path'
import { RunReport, StepReport, StepOutcome } from '@types-local/index'
import { createLogger } from '@types-local/logger'

const logger = createLogger('PlanRecorder')

// ── public API ────────────────────────────────────────────────────────────────

export class PlanRecorder {
  // Write recorded-plan.md into the run's report directory.
  // The file mirrors the source plan's step list but annotates each step with
  // the actual execution outcome, the element that was interacted with, and any
  // healing or assertion details.  It is diffable against the original .md so
  // that intended application changes can be reviewed and promoted to the plan.
  async write(report: RunReport, dir: string): Promise<void> {
    const md = buildMarkdown(report)
    const filePath = path.join(dir, 'recorded-plan.md')
    await writeFile(filePath, md, 'utf-8')
    logger.info(`Recorded plan written → ${filePath}`)
  }
}

// ── markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown(report: RunReport): string {
  const date = new Date(report.startedAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  const passCount = report.steps.filter(
    s => s.outcome === 'PASS' || s.outcome === 'HEALED',
  ).length
  const healCount = report.steps.filter(s => s.outcome === 'HEALED').length
  const total = report.steps.length

  const lines: string[] = [
    `# Execution Record — ${path.basename(report.planFile)}`,
    ``,
    `<!-- run: ${report.runId} -->`,
    `<!-- date: ${date} -->`,
    `<!-- target: ${report.targetUrl} -->`,
    `<!-- source-plan: ${report.planFile} -->`,
    `<!-- outcome: ${report.outcome} | ${passCount}/${total} passed${healCount ? ` (${healCount} healed)` : ''} -->`,
    ``,
    `> Auto-recorded by Pliant. Compare against \`${report.planFile}\` to identify`,
    `> steps that need updating due to application changes.`,
    ``,
    `## Execution Summary`,
    ``,
    summaryTable(report.steps),
    ``,
    `## Recorded Steps`,
    ``,
    `<!-- Each step shows the original intent annotated with what actually ran.    -->`,
    `<!-- HEALED = runner used a fallback; the element comment shows what was used. -->`,
    `<!-- FAIL = assertion or interaction failed; see inline notes.                -->`,
    ``,
  ]

  for (const step of report.steps) {
    lines.push(...recordedStep(step))
    lines.push(``)
  }

  return lines.join('\n')
}

function summaryTable(steps: StepReport[]): string {
  const rows = steps.map(s => {
    const icon = outcomeIcon(s.outcome)
    const el = s.matchedElement
      ? `${s.matchedElement.tag}[${(s.matchedElement.label ?? '').slice(0, 40)}]`
      : '—'
    const notes = buildNotes(s)
    return `| ${s.stepNumber} | ${icon} ${s.outcome} | ${esc(el)} | ${esc(notes)} |`
  })
  return [
    `| # | Outcome | Element matched | Notes |`,
    `|---|---------|----------------|-------|`,
    ...rows,
  ].join('\n')
}

function recordedStep(step: StepReport): string[] {
  const icon = outcomeIcon(step.outcome)
  const lines: string[] = [`${step.stepNumber}. ${step.intent}`]

  // Outcome + element line
  const el = step.matchedElement
  const elDesc = el
    ? `${el.tag}[${(el.label ?? 'unlabeled').slice(0, 50)}] (confidence: ${el.confidence.toFixed(2)})`
    : 'no element matched'
  lines.push(`   <!-- ${icon} ${step.outcome} | ${elDesc} | ${step.durationMs}ms -->`)

  // Healing events
  for (const h of step.healingEvents) {
    lines.push(`   <!-- ⚠ HEALED: ${h.type} — ${h.description} -->`)
  }

  // Assertions
  for (const a of step.assertions) {
    const mark = a.pass ? '✓' : '✗'
    lines.push(`   - expect: ${a.expect}`)
    lines.push(`     <!-- ${mark} ${a.pass ? 'PASS' : 'FAIL'}: ${a.reasoning.slice(0, 120)} -->`)
  }

  // Business rule
  if (step.businessRule !== null) {
    const br = step.businessRule
    const mark = br.pass ? '✓' : '✗'
    const vals = Object.entries(br.capturedValues)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    lines.push(`   <!-- ${mark} RULE ${br.ruleId}: ${br.evaluatedFormula} | ${vals} -->`)
    if (!br.pass && br.failReason) {
      lines.push(`   <!-- FAIL reason: ${br.failReason} -->`)
    }
  }

  // After: dependencies (reconstruct from step number heuristic — not stored in report,
  // so we note when the step is one of the known post-checkout steps)
  return lines
}

function buildNotes(step: StepReport): string {
  const parts: string[] = []
  if (step.healingEvents.length > 0) {
    parts.push(step.healingEvents.map(h => h.type).join(', '))
  }
  if (step.outcome === 'FAIL') {
    const failedAsserts = step.assertions.filter(a => !a.pass)
    const firstFail = failedAsserts[0]
    if (firstFail !== undefined) {
      parts.push(`assert failed: ${firstFail.expect.slice(0, 50)}`)
    } else if (step.businessRule !== null && !step.businessRule.pass) {
      parts.push(`rule ${step.businessRule.ruleId} failed`)
    }
  }
  return parts.join('; ') || '—'
}

function outcomeIcon(outcome: StepOutcome): string {
  const icons: Record<StepOutcome, string> = {
    PASS: '✓', FAIL: '✗', HEALED: '⚠', SKIPPED: '⏭', STUCK: '💥',
  }
  return icons[outcome] ?? '?'
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|')
}
