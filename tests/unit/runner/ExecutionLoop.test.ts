import { test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ExecutionLoop } from '@runner/ExecutionLoop'
import { AssertionEvaluator } from '@runner/AssertionEvaluator'
import { BusinessRuleEvaluator } from '@runner/BusinessRuleEvaluator'
import { ElementExtractor } from '@locator/ElementExtractor'
import { SemanticMatcher } from '@locator/SemanticMatcher'
import { ScreenshotManager } from '@report/ScreenshotManager'
import { ReportBuilder } from '@report/ReportBuilder'
import { ClickInterceptedError } from '@types-local/errors'
import { RunConfig, Step, TestPlan } from '@types-local/index'
import { FakeDriver, fakeElement } from '@fixtures/FakeDriver'
import { MockLLMClient } from '@fixtures/MockLLMClient'

// The execution loop runs entirely against FakeDriver here: no browser and no
// Playwright. Passing these tests shows the loop depends only on BrowserDriver.

const TARGET = 'https://shop.example.test/'

function step(number: number, intent: string, expects: string[], extra: Partial<Step> = {}): Step {
  return {
    id: String(number), number, intent, expects,
    rules: null, stop: false, after: [], element: null,
    ...extra,
  }
}

function matchResponse(elementIndex: number, fillValue: string | null): string {
  return JSON.stringify({ elementIndex, confidence: 0.95, reasoning: 'test', fillValue, alternativeIndices: [] })
}

const PASS = JSON.stringify({ pass: true, reasoning: 'test' })

async function setup() {
  const reportDir = await mkdtemp(path.join(os.tmpdir(), 'pliant-loop-'))
  const config: RunConfig = {
    targetUrl: TARGET, headless: true, slowMo: 0, llmProvider: 'ollama',
    reportOutputDir: reportDir, planFile: 'unused.md', driver: 'playwright',
    browserType: 'chromium', humanTiming: { enabled: false, stepDelayMin: 0, stepDelayMax: 0 },
  }

  const llm = new MockLLMClient()
  const extractor = new ElementExtractor()
  const matcher = new SemanticMatcher(llm)
  const reportBuilder = new ReportBuilder('test-run', config, 'mock')
  const loop = new ExecutionLoop(
    llm, extractor, matcher,
    new AssertionEvaluator(llm),
    new BusinessRuleEvaluator(extractor, matcher),
    new ScreenshotManager(path.join(reportDir, 'screenshots')),
    reportBuilder,
    config.humanTiming,
  )

  // A small search page: one text field, a submit button, and some links so the
  // loop sees enough candidates to treat the page as loaded.
  const driver = new FakeDriver()
  driver.elements = [
    fakeElement({ index: 0, tag: 'input', selector: '#q', label: 'Search', inputType: 'text' }),
    fakeElement({ index: 1, tag: 'button', selector: '#go', text: 'Search' }),
    fakeElement({ index: 2, tag: 'a', selector: '#home', text: 'Home', region: 'nav' }),
    fakeElement({ index: 3, tag: 'a', selector: '#about', text: 'About', region: 'nav' }),
    fakeElement({ index: 4, tag: 'a', selector: '#help', text: 'Help', region: 'footer' }),
  ]
  driver.onClick = selector => {
    if (selector === '#go') driver.url = `${TARGET}results?q=widget`
  }

  llm.setResponse('Enter "widget" into the search field', matchResponse(0, 'widget'))
  llm.setResponse('Click the search button', matchResponse(1, null))
  llm.setResponse('evaluating whether a natural language assertion holds', PASS)

  const plan: TestPlan = {
    title: 'Search',
    scenarios: [{
      title: 'Search for a product',
      steps: [
        step(1, 'Enter "widget" into the search field', ['The search field accepts input']),
        step(2, 'Click the search button', ['Search results are displayed'], { stop: true }),
      ],
    }],
  }

  return { loop, driver, plan, reportBuilder, cleanup: () => rm(reportDir, { recursive: true, force: true }) }
}

test.describe('ExecutionLoop on a non-Playwright driver', () => {
  test('runs a plan end to end through BrowserDriver', async () => {
    const { loop, driver, plan, reportBuilder, cleanup } = await setup()
    try {
      await loop.run(plan, driver, TARGET)
      const report = await reportBuilder.finishRun()

      expect(report.steps.map(s => [s.stepId, s.outcome])).toEqual([['1', 'PASS'], ['2', 'PASS']])
      expect(driver.callsTo('goto')).toEqual([[TARGET]])
      expect(driver.callsTo('typeText').map(args => args.slice(0, 2))).toEqual([['#q', 'widget']])
      expect(driver.callsTo('click').map(args => args[0])).toEqual(['#q', '#go'])
      expect(await driver.currentUrl()).toBe(`${TARGET}results?q=widget`)
    } finally {
      await cleanup()
    }
  })

  test('recovers from an intercepted click by pressing Escape and retrying', async () => {
    const { loop, driver, plan, reportBuilder, cleanup } = await setup()
    try {
      // The type step clicks #q first; the search click is the second click.
      // Make that second click hit an overlay once.
      let clicks = 0
      const baseOnClick = driver.onClick
      driver.onClick = selector => {
        clicks++
        if (clicks === 1) driver.clickErrors.push(new ClickInterceptedError('overlay'))
        baseOnClick(selector)
      }

      await loop.run(plan, driver, TARGET)
      const report = await reportBuilder.finishRun()

      expect(report.steps.map(s => s.outcome)).toEqual(['PASS', 'PASS'])
      expect(driver.callsTo('pressKey')).toContainEqual(['Escape'])
      expect(driver.callsTo('click').map(args => args[0])).toEqual(['#q', '#go', '#go'])
    } finally {
      await cleanup()
    }
  })
})
