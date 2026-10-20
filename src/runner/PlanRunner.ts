import * as path from 'path'
import { PlanParser } from '@parser/PlanParser'
import { BrowserDriver, DriverName } from '@driver/BrowserDriver'
import { PlaywrightDriver } from '@driver/PlaywrightDriver'
import { LLMClient } from '@llm/LLMClient'
import { ClaudeClient, ClaudeEffort, DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL } from '@llm/ClaudeClient'
import { OllamaClient } from '@llm/OllamaClient'
import { ElementExtractor } from '@locator/ElementExtractor'
import { SemanticMatcher } from '@locator/SemanticMatcher'
import { AssertionEvaluator } from '@runner/AssertionEvaluator'
import { BusinessRuleEvaluator } from '@runner/BusinessRuleEvaluator'
import { ExecutionLoop } from '@runner/ExecutionLoop'
import { ScreenshotManager } from '@report/ScreenshotManager'
import { ReportBuilder } from '@report/ReportBuilder'
import { PlanRecorder } from '@report/PlanRecorder'
import { PlanEnricher } from '@report/PlanEnricher'
import { HtmlReporter } from '@report/HtmlReporter'
import { RunConfig, LLMProvider, BrowserType, HumanTiming } from '@types-local/index'
import { createLogger } from '@types-local/logger'

const logger = createLogger('PlanRunner')

// ── entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = readConfig()
  logger.info(`Target: ${config.targetUrl}  LLM: ${config.llmProvider}  Driver: ${config.driver}  Plan: ${config.planFile}`)

  const parser = new PlanParser()
  const plan = await parser.parseFile(config.planFile)

  const llm = createLLMClient(config)
  const llmModel = resolveLLMModel(config)

  const runId = createRunId(config.targetUrl)
  const screenshotDir = path.join(config.reportOutputDir, runId, 'screenshots')
  const reportBuilder = new ReportBuilder(runId, config, llmModel)
  const screenshotMgr  = new ScreenshotManager(screenshotDir)

  const extractor  = new ElementExtractor()
  const matcher    = new SemanticMatcher(llm)
  const assertEval = new AssertionEvaluator(llm)
  const ruleEval   = new BusinessRuleEvaluator(extractor, matcher)
  const runDir     = path.join(config.reportOutputDir, runId)
  const enricher   = new PlanEnricher(config.planFile, path.join(runDir, 'enriched-plan.md'))
  const loop       = new ExecutionLoop(
    llm, extractor, matcher, assertEval, ruleEval, screenshotMgr, reportBuilder, config.humanTiming, enricher,
  )

  const driver = await createDriver(config)

  let runFailed = false
  try {
    await extractor.addListenerTracker(driver)
    await loop.run(plan, driver, config.targetUrl)
  } catch (err) {
    logger.error(`Run aborted: ${String(err)}`)
    runFailed = true
  } finally {
    await driver.close().catch(() => {})
  }

  // Always attempt to write the report, even when the run was aborted mid-flight.
  // This preserves partial results so recorded-plan.md and plan-comparison.html
  // still show what ran before the crash (e.g. bot-protection page invalidating
  // the browser context).
  const report = await reportBuilder.finishRun()
  logger.info(`Run complete: ${report.outcome} (${report.steps.length} steps)`)

  await new PlanRecorder().write(report, runDir)
  if (enricher.wroteOutput) {
    logger.info(
      `Element hints from this run: ${enricher.outputPlanFile} — ` +
      `review it and copy it over ${config.planFile} only if the new hints are better`,
    )
  }
  await new HtmlReporter().generatePlanComparison(
    runDir,
    path.join(runDir, 'plan-comparison.html'),
  )

  process.exit(runFailed || report.outcome === 'FAIL' ? 1 : 0)
}

// ── config ────────────────────────────────────────────────────────────────────

function readConfig(): RunConfig {
  const targetUrl = process.env['TARGET_URL']
  if (!targetUrl) throw new Error('TARGET_URL environment variable is required')

  const llmProviderRaw = (process.env['LLM_PROVIDER'] ?? 'ollama').toLowerCase()
  const llmProvider: LLMProvider =
    llmProviderRaw === 'ollama' ? 'ollama' : 'claude'

  const humanTimingEnabled = (process.env['HUMAN_TIMING'] ?? 'false') === 'true'
  const humanTiming: HumanTiming = {
    enabled:       humanTimingEnabled,
    stepDelayMin:  Number(process.env['STEP_DELAY_MIN'] ?? (humanTimingEnabled ? 600  : 0)),
    stepDelayMax:  Number(process.env['STEP_DELAY_MAX'] ?? (humanTimingEnabled ? 1800 : 0)),
  }

  const driverRaw = (process.env['BROWSER_DRIVER'] ?? 'playwright').toLowerCase()
  if (driverRaw !== 'playwright') {
    throw new Error(`Unsupported BROWSER_DRIVER "${driverRaw}" (supported: playwright)`)
  }
  const driver: DriverName = driverRaw

  const browserTypeRaw = (process.env['BROWSER_TYPE'] ?? 'chromium').toLowerCase()
  const browserType: BrowserType =
    browserTypeRaw === 'firefox' ? 'firefox'
    : browserTypeRaw === 'webkit' ? 'webkit'
    : 'chromium'

  return {
    targetUrl,
    headless:        (process.env['HEADLESS'] ?? 'true') !== 'false',
    slowMo:          Number(process.env['SLOW_MO'] ?? 0),
    llmProvider,
    reportOutputDir: process.env['REPORT_OUTPUT_DIR'] ?? './reports',
    planFile:        process.env['PLAN_FILE'] ?? 'plans/shopping-cart.md',
    driver,
    browserType,
    humanTiming,
  }
}

// The only place a concrete driver is constructed. Add new drivers here.
async function createDriver(config: RunConfig): Promise<BrowserDriver> {
  switch (config.driver) {
    case 'playwright':
      return PlaywrightDriver.launch({
        browserType: config.browserType,
        headless:    config.headless,
        slowMo:      config.slowMo,
        viewport:    { width: 1280, height: 800 },
      })
  }
}

function createLLMClient(config: RunConfig): LLMClient {
  if (config.llmProvider === 'claude') {
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? ''
    if (apiKey === '') throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude')
    return new ClaudeClient(apiKey, { model: resolveLLMModel(config), effort: readClaudeEffort() })
  }
  const baseUrl = process.env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL
  return new OllamaClient(baseUrl, resolveLLMModel(config))
}

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'
const DEFAULT_OLLAMA_MODEL = 'mistral'
const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function resolveLLMModel(config: RunConfig): string {
  if (config.llmProvider === 'claude') return process.env['CLAUDE_MODEL'] || DEFAULT_CLAUDE_MODEL
  return process.env['OLLAMA_MODEL'] || DEFAULT_OLLAMA_MODEL
}

// CLAUDE_EFFORT=none omits the effort setting, for models that do not accept one.
function readClaudeEffort(): ClaudeEffort | null {
  const raw = (process.env['CLAUDE_EFFORT'] || DEFAULT_CLAUDE_EFFORT).toLowerCase()
  if (raw === 'none') return null
  const effort = CLAUDE_EFFORTS.find(e => e === raw)
  if (effort === undefined) {
    throw new Error(`Unsupported CLAUDE_EFFORT "${raw}" (supported: ${CLAUDE_EFFORTS.join(', ')}, none)`)
  }
  return effort
}

function createRunId(targetUrl: string): string {
  const hostname  = new URL(targetUrl).hostname
  const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19)
  return `${hostname}-${timestamp}`
}

// ── run ───────────────────────────────────────────────────────────────────────

main().catch(error => {
  logger.error(`Fatal error: ${String(error)}`)
  process.exit(1)
})
