import { writeFile, mkdir } from 'fs/promises'
import * as path from 'path'
import {
  RunReport, StepReport, Step, StepResult, RunConfig, RunOutcome, StepOutcome,
} from '@types-local/index'
import { createLogger } from '@types-local/logger'

const logger = createLogger('ReportBuilder')

export class ReportBuilder {
  private readonly steps: StepReport[] = []
  private readonly startedAt = new Date().toISOString()

  constructor(
    private readonly runId: string,
    private readonly config: RunConfig,
    private readonly llmModel: string,
  ) {}

  recordStep(step: Step, result: StepResult): void {
    const report: StepReport = {
      stepId:           step.id,
      stepNumber:       step.number,
      intent:           step.intent,
      outcome:          result.outcome,
      locatorStrategy:  result.locatorStrategy,
      matchedElement:   result.matchedElement,
      healingEvents:    result.healingEvents,
      assertions:       result.assertionResults,
      businessRule:     result.businessRuleResult,
      screenshots:      result.screenshots,
      durationMs:       result.durationMs,
    }
    this.steps.push(report)
    logger.debug(`step ${step.id} recorded outcome=${result.outcome}`)
  }

  // Record a step that was never executed (skipped / stuck).
  recordSkipped(step: Step, outcome: StepOutcome): void {
    this.steps.push({
      stepId:          step.id,
      stepNumber:      step.number,
      intent:          step.intent,
      outcome,
      locatorStrategy: 'NOT_FOUND',
      matchedElement:  null,
      healingEvents:   [],
      assertions:      [],
      businessRule:    null,
      screenshots:     { fullPage: '', element: null },
      durationMs:      0,
    })
  }

  async finishRun(): Promise<RunReport> {
    const outcome = deriveRunOutcome(this.steps)
    const report: RunReport = {
      runId:       this.runId,
      site:        new URL(this.config.targetUrl).hostname,
      targetUrl:   this.config.targetUrl,
      planFile:    this.config.planFile,
      startedAt:   this.startedAt,
      completedAt: new Date().toISOString(),
      outcome,
      llmProvider: this.config.llmProvider,
      llmModel:    this.llmModel,
      steps:       this.steps,
    }

    const dir = path.join(this.config.reportOutputDir, this.runId)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, 'run.json')
    await writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8')
    logger.info(`Run report written to ${filePath}`)

    return report
  }
}

function deriveRunOutcome(steps: StepReport[]): RunOutcome {
  if (steps.some(s => s.outcome === 'STUCK')) return 'STUCK'
  if (steps.some(s => s.outcome === 'FAIL'))  return 'FAIL'
  return 'PASS'
}
