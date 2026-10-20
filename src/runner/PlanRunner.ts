import { chromium, firefox, webkit } from '@playwright/test'
import { readFile } from 'fs/promises'
import * as path from 'path'
import { PlanParser } from '@parser/PlanParser'
import { LLMClient } from '@llm/LLMClient'
import { ClaudeClient } from '@llm/ClaudeClient'
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
  logger.info(`Target: ${config.targetUrl}  LLM: ${config.llmProvider}  Plan: ${config.planFile}`)

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
  const enricher   = new PlanEnricher(config.planFile)
  const loop       = new ExecutionLoop(
    llm, extractor, matcher, assertEval, ruleEval, screenshotMgr, reportBuilder, config.humanTiming, enricher,
  )

  const browserModule = config.browserType === 'firefox' ? firefox
    : config.browserType === 'webkit' ? webkit
    : chromium

  // Chromium gets an extra arg to suppress the automation banner; Firefox/WebKit do not.
  const launchOptions = config.browserType === 'chromium'
    ? { headless: config.headless, slowMo: config.slowMo, args: ['--disable-blink-features=AutomationControlled'] }
    : { headless: config.headless, slowMo: config.slowMo }

  const browser = await browserModule.launch(launchOptions)

  let runFailed = false
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()
    await extractor.addListenerTracker(page)
    await loop.run(plan, page, config.targetUrl)
  } catch (err) {
    logger.error(`Run aborted: ${String(err)}`)
    runFailed = true
  } finally {
    await browser.close().catch(() => {})
  }

  // Always attempt to write the report, even when the run was aborted mid-flight.
  // This preserves partial results so recorded-plan.md and plan-comparison.html
  // still show what ran before the crash (e.g. bot-protection page invalidating
  // the browser context).
  const report = await reportBuilder.finishRun()
  logger.info(`Run complete: ${report.outcome} (${report.steps.length} steps)`)

  const runDir = path.join(config.reportOutputDir, runId)
  await new PlanRecorder().write(report, runDir)
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

  const humanTimingEnabled = (process.env['HUMAN_TIMING'] ?? 'true') !== 'false'
  const humanTiming: HumanTiming = {
    enabled:       humanTimingEnabled,
    stepDelayMin:  Number(process.env['STEP_DELAY_MIN'] ?? (humanTimingEnabled ? 600  : 0)),
    stepDelayMax:  Number(process.env['STEP_DELAY_MAX'] ?? (humanTimingEnabled ? 1800 : 0)),
  }

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
    browserType,
    humanTiming,
  }
}

function createLLMClient(config: RunConfig): LLMClient {
  if (config.llmProvider === 'claude') {
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? ''
    if (apiKey === '') throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude')
    return new ClaudeClient(apiKey)
  }
  const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://host.docker.internal:11434'
  const model   = process.env['OLLAMA_MODEL']    ?? 'mistral'
  return new OllamaClient(baseUrl, model)
}

function resolveLLMModel(config: RunConfig): string {
  if (config.llmProvider === 'claude') return 'claude-sonnet-4-20250514'
  return process.env['OLLAMA_MODEL'] ?? 'mistral'
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
