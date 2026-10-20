/// <reference lib="dom" />
import type { Page } from '@playwright/test'
import { LLMClient } from '@llm/LLMClient'
import { ElementExtractor } from '@locator/ElementExtractor'
import { SemanticMatcher } from '@locator/SemanticMatcher'
import { AssertionEvaluator } from '@runner/AssertionEvaluator'
import { BusinessRuleEvaluator } from '@runner/BusinessRuleEvaluator'
import { StepScheduler } from '@runner/StepScheduler'
import { ScreenshotManager } from '@report/ScreenshotManager'
import { ReportBuilder } from '@report/ReportBuilder'
import { PlanEnricher } from '@report/PlanEnricher'
import {
  TestPlan, Scenario, Step, MatchResult, ExtractedElement,
  BusinessRuleReport, HealingEvent, StepResult, StepOutcome,
  LocatorStrategy, HumanTiming,
} from '@types-local/index'
import { CONFIDENCE_THRESHOLD, MIN_CONFIDENCE, MAX_CONSECUTIVE_ADVANCES } from '@types-local/constants'
import { createLogger } from '@types-local/logger'

const logger = createLogger('ExecutionLoop')

export class ExecutionLoop {
  constructor(
    private readonly llm: LLMClient,
    private readonly extractor: ElementExtractor,
    private readonly matcher: SemanticMatcher,
    private readonly assertionEvaluator: AssertionEvaluator,
    private readonly ruleEvaluator: BusinessRuleEvaluator,
    private readonly screenshotManager: ScreenshotManager,
    private readonly reportBuilder: ReportBuilder,
    private readonly humanTiming: HumanTiming,
    private readonly planEnricher: PlanEnricher | null = null,
  ) {}

  async run(plan: TestPlan, page: Page, targetUrl: string): Promise<void> {
    for (const scenario of plan.scenarios) {
      logger.info(`Running scenario: ${scenario.title}`)
      await this.runScenario(scenario, page, targetUrl)
    }
  }

  // ── scenario loop ───────────────────────────────────────────────────────────

  private async runScenario(scenario: Scenario, page: Page, targetUrl: string): Promise<void> {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
    await waitForSettle(page)

    const scheduler = new StepScheduler(scenario.steps)
    let consecutiveRecoveries = 0

    while (scheduler.hasPending()) {
      const step = scheduler.next()

      if (step === null) {
        logger.warn('No eligible step — unmet after: dependencies')
        for (const s of scheduler.drainPending()) {
          this.reportBuilder.recordSkipped(s, 'STUCK')
        }
        break
      }

      logger.info(`Attempting step ${step.id} on ${page.url()}: ${step.intent}`)
      const result = isNavigationToHome(step.intent)
        ? await this.executeHomeNavigation(page, targetUrl)
        : await this.executeStep(step, page)

      if (result.locatorStrategy !== 'NOT_FOUND') {
        consecutiveRecoveries = 0
        scheduler.markComplete(step)
        this.reportBuilder.recordStep(step, result)
        logger.info(`Step ${step.id} → ${result.outcome}`)

        if (step.stop) {
          logger.info('stop: true reached — marking remaining steps SKIPPED')
          for (const s of scheduler.drainPending()) {
            this.reportBuilder.recordSkipped(s, 'SKIPPED')
          }
          break
        }
        await this.stepJitter()
        continue
      }

      // Element not found — try to recover by running an adjacent step or advancing the page,
      // then retry this step on the next iteration.
      logger.info(`Step ${step.id} element not found — attempting recovery`)
      consecutiveRecoveries++

      if (consecutiveRecoveries >= MAX_CONSECUTIVE_ADVANCES) {
        logger.warn(`${MAX_CONSECUTIVE_ADVANCES} consecutive recovery attempts — stuck`)
        scheduler.markComplete(step)
        this.reportBuilder.recordStep(step, result)
        for (const s of scheduler.drainPending()) {
          this.reportBuilder.recordSkipped(s, 'STUCK')
        }
        break
      }

      const recovered = await this.recover(step, scheduler, page)
      if (!recovered) {
        logger.warn(`No recovery available for step ${step.id} — marking failed`)
        consecutiveRecoveries = 0
        scheduler.markComplete(step)
        this.reportBuilder.recordStep(step, result)
      }
      // If recovered, step remains pending and is retried on the next iteration
    }
  }

  // ── per-step execution ──────────────────────────────────────────────────────

  private async executeStep(step: Step, page: Page): Promise<StepResult> {
    const start = Date.now()
    const healingEvents: HealingEvent[] = []

    // Pure validation steps ("validate X", "verify Y") with a business rules block
    // should not interact with any page element — they only read page state to check
    // assertions and evaluate the formula. Forcing an interaction risks navigating away
    // from the page being validated (e.g. accidentally clicking the Wishlist link).
    if (isValidationOnlyStep(step.intent) && step.rules !== null) {
      await waitForSettle(page)
      const freshCandidates = await this.extractor.extract(page)
      const pageText = await page.evaluate(() => (document.body.innerText ?? '').slice(0, 5000)).catch(() => '')
      const assertionResults = await this.assertionEvaluator.evaluate(
        step.expects, freshCandidates, page.url(), false, pageText)
      const businessRuleResult = await this.ruleEvaluator.evaluate(step.rules, page)
      const screenshots = await this.screenshotManager.capture(page, null, step.number)
      const allPassed =
        assertionResults.every(r => r.pass) &&
        (businessRuleResult === null || businessRuleResult.pass)
      const outcome: StepOutcome = allPassed ? 'PASS' : 'FAIL'
      return {
        outcome,
        locatorStrategy: 'DIRECT',
        match: null,
        matchedElement: null,
        assertionResults,
        businessRuleResult,
        healingEvents,
        screenshots,
        durationMs: Date.now() - start,
        error: null,
      }
    }

    if (stepIsDismissDialog(step.intent)) {
      // Dismiss-modal steps close the product drawer after adding an item.
      // If the drawer is already gone (site auto-dismissed it), the step's goal
      // is achieved — fast-pass so execution continues to the next step.
      const dialogOpen = await anyDialogVisible(page)
      if (!dialogOpen) {
        logger.info(`Step ${step.id} — dialog already closed, fast-passing`)
        return {
          outcome: 'PASS',
          locatorStrategy: 'DIRECT',
          match: null,
          matchedElement: null,
          assertionResults: [],
          businessRuleResult: null,
          healingEvents,
          screenshots: { fullPage: '', element: null },
          durationMs: Date.now() - start,
          error: null,
        }
      }
      // Dialog is open — fall through to element matching to find and click the close button
    } else if (stepRequiresOpenDialog(step.intent)) {
      // This step must act inside an already-open product modal/drawer.
      // We detect it by looking for an open dialog that actually contains an
      // Add-to-Cart button — this distinguishes a product drawer from persistent
      // overlays (e.g. sign-in prompts) that also carry role="dialog".
      const productDialogOpen = await productDialogWithCartButton(page)
      if (!productDialogOpen) {
        logger.info(`Step ${step.id} requires an open product dialog — none present, marking complete`)
        return this.failedResult(start, null, null, 'SEMANTIC', healingEvents,
          'Step requires an open product modal/dialog with Add-to-Cart, but none is present')
      }
    }

    let candidates = await this.extractor.extract(page).catch(async (err: unknown) => {
      // SPA navigation mid-evaluate destroys the execution context. Re-settle and retry once.
      if (String(err).includes('context was destroyed')) {
        logger.warn('Extraction context destroyed by navigation — re-settling and retrying')
        await waitForSettle(page)
        return this.extractor.extract(page)
      }
      throw err
    })
    logger.debug(`Extracted ${candidates.length} candidates`)

    // If very few elements found, the page may still be on a redirect or security-check
    // intermediate page. Wait up to 8 s for the real page to load, then retry once.
    if (candidates.length < 5) {
      logger.debug('Too few candidates — waiting for page to fully settle')
      await new Promise<void>(r => setTimeout(r, 5000))
      await waitForSettle(page)
      candidates = await this.extractor.extract(page)
      logger.debug(`Re-extracted ${candidates.length} candidates`)
    }

    let match: MatchResult
    try {
      match = await this.matcher.match(step.intent, candidates, step.id, step.element)
    } catch (error) {
      return this.failedResult(start, null, null, 'NOT_FOUND', healingEvents, String(error))
    }

    // Fallback for dismiss-dialog steps: if the LLM returned null but the dialog is
    // open, find the first button in the dialog labelled "close" (or any X button),
    // then fall back to the very first dialog button. Handles Mistral returning null
    // when "Continue Shopping" is absent but a visible close button exists.
    if (stepIsDismissDialog(step.intent) && match.elementIndex === -1) {
      const dialogButtons = candidates.filter(el => el.region === 'dialog' && el.tag === 'button')
      const closeBtn = dialogButtons.find(el =>
        /\bclose\b|^x$/i.test(el.label ?? el.text)
      ) ?? dialogButtons[0]
      if (closeBtn !== undefined) {
        logger.debug(`Dismiss-dialog fallback: using dialog button #${closeBtn.index} "${(closeBtn.label ?? closeBtn.text).slice(0, 30)}"`)
        match = {
          ...match,
          elementIndex: closeBtn.index,
          confidence: MIN_CONFIDENCE,
          reasoning: `LLM null-match fallback: selected close button in dialog`,
        }
        healingEvents.push({
          type: 'LOW_CONFIDENCE',
          description: 'Dismiss-dialog fallback triggered (LLM returned null; using close button)',
          confidence: MIN_CONFIDENCE,
        })
      }
    }

    // Fallback for text-entry steps: Mistral 7B sometimes returns elementIndex: null
    // (sentinel -1 after parse) even when only one or two inputs are present. When it
    // does, it usually still provides the correct fillValue. Use the first visible
    // input/textarea as the target so recovery is not triggered unnecessarily.
    if (isTextEntryStep(step.intent) && match.elementIndex === -1 && match.fillValue !== null) {
      const firstInput = candidates.find(el => el.tag === 'input' || el.tag === 'textarea')
      if (firstInput !== undefined) {
        logger.debug(`Text-entry fallback: using first input #${firstInput.index} with value "${match.fillValue.slice(0, 40)}..."`)
        match = {
          ...match,
          elementIndex: firstInput.index,
          confidence: MIN_CONFIDENCE,
          reasoning: `LLM null-match fallback: first input (${(firstInput.label ?? firstInput.text).slice(0, 40)})`,
        }
        healingEvents.push({
          type: 'LOW_CONFIDENCE',
          description: `Text-entry fallback triggered (LLM returned null for element)`,
          confidence: MIN_CONFIDENCE,
        })
      }
    }

    let matchedEl = candidates.find(el => el.index === match.elementIndex) ?? null

    // ── healing decision tree ──────────────────────────────────────────────

    if (match.confidence < MIN_CONFIDENCE) {
      return this.failedResult(
        start, match, matchedEl, 'NOT_FOUND', healingEvents,
        `confidence ${match.confidence.toFixed(2)} below MIN_CONFIDENCE ${MIN_CONFIDENCE}`,
      )
    }

    let locatorStrategy: LocatorStrategy =
      match.confidence >= CONFIDENCE_THRESHOLD ? 'DIRECT' : 'SEMANTIC'

    if (locatorStrategy === 'SEMANTIC') {
      healingEvents.push({
        type: 'LOW_CONFIDENCE',
        description: `Low-confidence match (${match.confidence.toFixed(2)}): ${match.reasoning}`,
        confidence: match.confidence,
      })
    }

    if (matchedEl === null) {
      return this.failedResult(start, match, null, locatorStrategy, healingEvents,
        `elementIndex ${match.elementIndex} not found in candidates array`)
    }

    // ── fill-target type guard ─────────────────────────────────────────────
    // When the LLM returns a non-fillable element (e.g. <a> navigation link) for a
    // text-entry step, clicking it before fill() can cause an unintended navigation.
    // Intercept here — before interact() — and fall back to the first viable input.
    if (match.fillValue !== null && !isFillableTag(matchedEl.tag)) {
      const fallbackInput = candidates.find(el => el.tag === 'input' || el.tag === 'textarea')
      if (fallbackInput !== undefined) {
        logger.warn(
          `Fill-target type mismatch: LLM picked <${matchedEl.tag}> index=${matchedEl.index} ` +
          `("${(matchedEl.label ?? matchedEl.text).slice(0, 40)}") — ` +
          `falling back to first input index=${fallbackInput.index}`
        )
        healingEvents.push({
          type: 'LOW_CONFIDENCE',
          description: `Fill-target mismatch: <${matchedEl.tag}> replaced by first fillable input`,
          confidence: MIN_CONFIDENCE,
        })
        match = { ...match, elementIndex: fallbackInput.index, confidence: MIN_CONFIDENCE }
        matchedEl = fallbackInput
        locatorStrategy = 'SEMANTIC'
      } else {
        return this.failedResult(
          start, match, matchedEl, 'NOT_FOUND', healingEvents,
          `Fill-target <${matchedEl.tag}> is not fillable and no input/textarea fallback found`,
        )
      }
    }

    // ── interaction ────────────────────────────────────────────────────────

    // For <select> elements, if the LLM returned fillValue: null, extract the
    // intended option value from the step intent (e.g. 'Select "United States"...'
    // → "United States"). Without this, a null fillValue causes interact() to click
    // the select without changing the selection, silently leaving it at its default.
    if (matchedEl.tag === 'select' && match.fillValue === null) {
      const quoted = step.intent.match(/["']([^"']{1,60})["']/)?.[1] ?? null
      if (quoted !== null) {
        logger.debug(`Select fillValue fallback: extracted "${quoted}" from intent`)
        match = { ...match, fillValue: quoted }
      }
    }

    const interactOutcome = await this.interact(matchedEl, match.fillValue, page, step.intent)

    if (!interactOutcome.success) {
      return this.failedResult(start, match, matchedEl, locatorStrategy, healingEvents,
        interactOutcome.error ?? 'Interaction failed')
    }

    await waitForSettle(page)

    // For click interactions, wait up to 8s for a product dialog/drawer to appear.
    // Some retailers (e.g. Walgreens) make an AJAX call after the Add-to-Cart click
    // to determine store inventory and delivery options before rendering the picker
    // modal — this can take 5-8 s and outlasts the networkidle wait above.
    // The combined ARIA-dialog + ReactModalPortal selector covers both standard sites
    // and Walgreens' portal-based overlay pattern. Best-effort; timeout is swallowed.
    //
    // Optimization: first check if the dialog starts to appear within 500ms. If it does
    // not, skip the full 8s wait so freshCandidates is captured while page notifications
    // (e.g. "item added" banners) are still visible. Sites where the dialog truly loads
    // slowly (Walgreens) will show the dialog container within 500ms even if content
    // arrives later, so the full 8s wait is still applied in those cases.
    if (match.fillValue === null) {
      const dialogSelector = page
        .locator('[role="dialog"]:not([aria-hidden="true"]) button, .ReactModalPortal button')
        .filter({ hasText: /add.*(cart|bag)/i })
        .first()
      const dialogAppeared = await dialogSelector
        .waitFor({ state: 'visible', timeout: 500 })
        .then(() => true)
        .catch(() => false)
      if (dialogAppeared) {
        await dialogSelector
          .waitFor({ state: 'visible', timeout: 7500 })
          .catch(() => {})
      }
    }

    // ── assertions ─────────────────────────────────────────────────────────

    const freshCandidates = await this.extractor.extract(page)
    const productDialogOpen = match.fillValue === null ? await productDialogWithCartButton(page) : false
    const pageText = await page.evaluate(() => (document.body.innerText ?? '').slice(0, 5000)).catch(() => '')
    const assertionResults = await this.assertionEvaluator.evaluate(
      step.expects, freshCandidates, page.url(), productDialogOpen, pageText)

    let businessRuleResult: BusinessRuleReport | null = null
    if (step.rules !== null) {
      businessRuleResult = await this.ruleEvaluator.evaluate(step.rules, page)
    }

    const screenshots = await this.screenshotManager.capture(page, matchedEl, step.number)

    const allPassed =
      assertionResults.every(r => r.pass) &&
      (businessRuleResult === null || businessRuleResult.pass)

    const outcome: StepOutcome =
      !allPassed ? 'FAIL' : healingEvents.length > 0 ? 'HEALED' : 'PASS'

    // Enrich the plan with element context for this step so future runs can use
    // the container/neighbor data to improve matching accuracy.
    // Only writes hints above CONFIDENCE_THRESHOLD and with plausible labels
    // (both checked inside enrich()) to prevent wrong matches from corrupting the plan.
    if (allPassed && this.planEnricher !== null) {
      await this.planEnricher.enrich(step.number, step.intent, matchedEl, match.confidence).catch(err => {
        logger.warn(`Plan enrichment failed for step ${step.number}: ${String(err)}`)
      })
    }

    return {
      outcome,
      locatorStrategy,
      match,
      matchedElement: {
        path:        matchedEl.path,
        label:       matchedEl.label,
        tag:         matchedEl.tag,
        selector:    matchedEl.selector,
        confidence:  match.confidence,
        reasoning:   match.reasoning,
        boundingBox: matchedEl.boundingBox,
      },
      assertionResults,
      businessRuleResult,
      healingEvents,
      screenshots,
      durationMs: Date.now() - start,
      error: null,
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  // Pause for a random interval between steps to mimic human reading/thinking time.
  // No-op when humanTiming is disabled (fast mode).
  private async stepJitter(): Promise<void> {
    if (!this.humanTiming.enabled) return
    const { stepDelayMin, stepDelayMax } = this.humanTiming
    const delay = stepDelayMin + Math.floor(Math.random() * (stepDelayMax - stepDelayMin + 1))
    await new Promise<void>(r => setTimeout(r, delay))
  }

  private async executeHomeNavigation(page: Page, targetUrl: string): Promise<StepResult> {
    const start = Date.now()
    const current = page.url().replace(/\/$/, '')
    const target  = targetUrl.replace(/\/$/, '')

    if (!current.startsWith(target)) {
      logger.info(`Not at target URL — navigating to ${targetUrl}`)
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
      await waitForSettle(page)
    }

    return {
      outcome:            'PASS',
      locatorStrategy:    'DIRECT',
      match:              null,
      matchedElement:     null,
      assertionResults:   [],
      businessRuleResult: null,
      healingEvents:      [],
      screenshots:        { fullPage: '', element: null },
      durationMs:         Date.now() - start,
      error:              null,
    }
  }

  private async interact(
    element: ExtractedElement,
    fillValue: string | null,
    page: Page,
    intent: string = '',
  ): Promise<{ success: boolean; error: string | null }> {
    try {
      const locator = page.locator(element.selector).first()
      if (fillValue !== null) {
        if (element.tag === 'select') {
          // selectOption() is the correct API for <select> elements; fill() does nothing.
          // Try exact value match, then exact label, then partial/case-insensitive label
          // so "CA" matches options labeled "CA" OR "California" and vice-versa.
          await this.selectOption(locator, fillValue, page)
        } else {
          // Use pressSequentially instead of fill() so each character fires its own
          // keydown/keypress/keyup events at a humanlike interval (~85-150 ms).
          // fill() dispatches all text in one synthetic event with 0 ms between
          // characters — a strong bot-detection signal on Akamai-protected sites.
          // If an overlay (e.g. a product picker modal from the previous step) is
          // still open and intercepts the click, press Escape to dismiss it first.
          try {
            await locator.click({ timeout: 5000 })
          } catch (fillClickErr) {
            if (!String(fillClickErr).includes('intercepts pointer events')) throw fillClickErr
            logger.debug('Overlay blocking fill-click — pressing Escape to dismiss')
            await page.keyboard.press('Escape')
            await new Promise<void>(r => setTimeout(r, 600))
            await locator.click({ timeout: 5000 })
          }
          await locator.fill('')
          await locator.pressSequentially(fillValue, {
            delay: 85 + Math.floor(Math.random() * 65),
          })
        }
      } else {
        const urlBefore = page.url()
        // Move the mouse toward the element before clicking to produce a natural
        // pointer trajectory — Akamai scores the absence of prior mousemove events.
        const box = await locator.boundingBox().catch(() => null)
        if (box !== null) {
          await page.mouse.move(
            box.x + Math.round(box.width  * (0.3 + Math.random() * 0.4)),
            box.y + Math.round(box.height * (0.3 + Math.random() * 0.4)),
            { steps: 3 + Math.floor(Math.random() * 5) },
          )
        }
        // Three-stage click recovery for overlays that intercept pointer events:
        //  1. Regular click (5 s timeout)
        //  2. Escape + wait + retry (5 s) — dismisses one overlay layer
        //  3. Force click — bypasses overlay position check entirely as last resort
        //     (avoids pressing Escape twice, which can clear search field text)
        try {
          await locator.click({ timeout: 5000 })
        } catch (firstError) {
          if (!String(firstError).includes('intercepts pointer events')) throw firstError
          logger.debug('Modal overlay blocking click (attempt 2) — pressing Escape to dismiss')
          await page.keyboard.press('Escape')
          await new Promise<void>(r => setTimeout(r, 600))
          try {
            await locator.click({ timeout: 5000 })
          } catch {
            // Force-click bypasses overlay position check without another Escape.
            logger.debug('Still blocked after Escape — using force click')
            await locator.click({ force: true, timeout: 5000 })
          }
        }
        // Give SPA/server navigation 200 ms to update the URL, then wait for
        // the new page to settle so assertions don't run against the old page.
        // When the URL is unchanged, also wait for networkidle so AJAX-driven DOM
        // updates (add-to-cart notifications, accordion panels) are rendered before
        // assertions capture freshCandidates and pageText.
        await new Promise<void>(r => setTimeout(r, 200))
        if (page.url() !== urlBefore) {
          await waitForSettle(page)
        } else if (isSearchSubmitIntent(intent)) {
          // URL unchanged after clicking what should be a search submit button.
          // The LLM may have matched an autocomplete container, a review radio button,
          // or another non-submit element. Re-focus the search input (detected as the
          // first text/search input on the page that has a value) then press Enter —
          // this reliably submits the search regardless of where focus currently is.
          logger.debug('Search-submit click did not navigate — pressing Enter as fallback')
          await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
              'input[type="text"], input[type="search"], input:not([type])',
            ))
            const filled = inputs.find(el => el.value.trim().length > 0)
            if (filled !== undefined) filled.focus()
          })
          await page.keyboard.press('Enter')
          await new Promise<void>(r => setTimeout(r, 300))
          if (page.url() !== urlBefore) {
            await waitForSettle(page)
          }
        } else {
          // URL unchanged and not a search submit: wait for AJAX-driven DOM updates
          // (add-to-cart notifications, accordion panels) before assertions run.
          await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {})
        }
        // Detect unexpected login-page redirects only for Add-to-Cart actions.
        // Guard against unexpected login-page redirects (e.g. Walgreens' quick-add flow
        // silently redirects to login). Skip the check when the intent explicitly mentions
        // login/checkout — those steps intentionally navigate to a login-gated page.
        const urlAfter = page.url()
        const isIntentionalLoginNav =
          intent.toLowerCase().includes('checkout') ||
          intent.toLowerCase().includes('login') ||
          intent.toLowerCase().includes('sign in')
        if (isLoginPage(urlAfter) && !isLoginPage(urlBefore) && !isIntentionalLoginNav) {
          logger.warn(`Unexpected redirect to login page: ${urlAfter}`)
          return { success: false, error: `Unexpected redirect to login page: ${urlAfter}` }
        }
      }
      return { success: true, error: null }
    } catch (error) {
      logger.warn(`Interaction failed "${element.selector}": ${String(error)}`)
      return { success: false, error: String(error) }
    }
  }

  // Fills a <select> element with the best-matching option, trying:
  //   1. Exact value attribute match  (e.g. value="CA")
  //   2. Exact label text match       (e.g. "California")
  //   3. Partial/case-insensitive label (e.g. "CA" matches "California"; "California" matches "CA")
  // This handles the state-abbreviation vs full-name ambiguity across retailers.
  private async selectOption(
    locator: import('@playwright/test').Locator,
    value: string,
    page: Page,
  ): Promise<void> {
    const strategies: Array<() => Promise<unknown>> = [
      () => locator.selectOption(value, { timeout: 3000 }),
      () => locator.selectOption({ label: value }, { timeout: 3000 }),
      async () => {
        // Collect all option texts and find the best partial/case-insensitive match.
        const optionTexts = await locator.locator('option').allTextContents()
        const lower = value.toLowerCase()
        const match =
          optionTexts.find(t => t.toLowerCase() === lower) ??
          optionTexts.find(t => t.toLowerCase().startsWith(lower)) ??
          optionTexts.find(t => lower.startsWith(t.toLowerCase().slice(0, 2))) ??
          optionTexts.find(t => t.toLowerCase().includes(lower))
        if (match === undefined) {
          throw new Error(`No <option> matching "${value}" in select (options: ${optionTexts.slice(0, 5).join(', ')})`)
        }
        await locator.selectOption({ label: match }, { timeout: 3000 })
      },
    ]
    let lastError: unknown
    for (const strategy of strategies) {
      try {
        await strategy()
        logger.debug(`selectOption("${value}") succeeded`)
        // Wait for any AJAX triggered by the change event (e.g. state dropdown reload
        // after country select) to complete before returning. The 300ms delay gives
        // setTimeout-deferred handlers time to fire before networkidle is checked.
        await new Promise<void>(r => setTimeout(r, 300))
        await waitForSettle(page)
        return
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  // Recovery when the target step's element is not found.
  //
  // Phase 1 — Page-state routing: scan the current DOM for unexecuted steps whose
  // element hint is visible on the page. Execute those steps (the UI flow changed
  // order), then let the target retry on the next iteration. Each step runs at most
  // once — markComplete() prevents cycles.
  //
  // Phase 2 — Adjacent step routing (fallback when no hints): try the nearest
  // lower-numbered pending step or click a forward affordance to advance the page.
  // Only steps with LOWER numbers than the target are eligible as recovery steps;
  // higher-numbered steps logically depend on the target completing first.
  private async recover(
    target: Step,
    scheduler: StepScheduler,
    page: Page,
  ): Promise<boolean> {
    // Phase 1: page-state-driven routing via element hints
    const candidates = await this.extractor.extract(page).catch((): ExtractedElement[] => [])
    const applicable = scheduler.findByPageState(candidates)
      .filter(s => s.id !== target.id)
      .sort((a, b) => a.number - b.number)

    if (applicable.length > 0) {
      logger.info(`Recovery: ${applicable.length} page-state-applicable step(s) for target ${target.id}`)
      for (const step of applicable) {
        logger.info(`Recovery: executing applicable step ${step.id} (page-state match)`)
        const result = await this.executeStep(step, page)
        scheduler.markComplete(step)
        this.reportBuilder.recordStep(step, result)
        logger.info(`Applicable step ${step.id} → ${result.outcome}`)
      }
      return true
    }

    // Phase 2: adjacent step routing and forward affordances
    const adjacent = scheduler.peekAdjacent(target.number, 2)
      .filter(s => s.number < target.number)
    const affordances = await this.extractor.extractForwardAffordances(page)
    const affordance = affordances[0] ?? null

    const adjacentStep = adjacent[0] ?? null
    const adjacentScore = adjacentStep !== null
      ? 1.0 - Math.abs(adjacentStep.number - target.number) * 0.3
      : 0
    const affordanceScore = affordance !== null ? 0.5 : 0

    logger.debug(
      `Recovery: adjacent=${adjacentScore.toFixed(2)} (step ${adjacentStep?.id ?? 'none'})` +
      ` | affordance=${affordanceScore.toFixed(2)} ("${affordance?.text.slice(0, 40) ?? 'none'}")`
    )

    if (adjacentStep !== null && adjacentScore >= affordanceScore) {
      const distance = Math.abs(adjacentStep.number - target.number)
      logger.info(`Recovery: executing adjacent step ${adjacentStep.id} (distance ${distance})`)
      const result = await this.executeStep(adjacentStep, page)
      scheduler.markComplete(adjacentStep)
      this.reportBuilder.recordStep(adjacentStep, result)
      logger.info(`Adjacent step ${adjacentStep.id} → ${result.outcome}`)
      return true
    }

    if (affordance !== null) {
      try {
        await page.locator(affordance.selector).first().click()
        logger.info(`Recovery: advanced page via "${affordance.text.slice(0, 60)}"`)
        await waitForSettle(page)
        return true
      } catch (error) {
        logger.warn(`Recovery advance failed: ${String(error)}`)
        return false
      }
    }

    return false
  }

  private async dismissOpenDialog(page: Page): Promise<void> {
    const open = await page
      .locator('[role="dialog"][aria-modal="true"]:not([aria-hidden="true"])')
      .first()
      .isVisible()
      .catch(() => false)
    if (open) {
      logger.debug('Dismissing carry-over modal dialog')
      await page.keyboard.press('Escape')
      await new Promise<void>(r => setTimeout(r, 400))
    }
  }

  private failedResult(
    start: number,
    match: MatchResult | null,
    element: ExtractedElement | null,
    locatorStrategy: LocatorStrategy,
    healingEvents: HealingEvent[],
    error: string,
  ): StepResult {
    return {
      outcome: 'FAIL',
      locatorStrategy,
      match,
      matchedElement: element !== null && match !== null ? {
        path:        element.path,
        label:       element.label,
        tag:         element.tag,
        selector:    element.selector,
        confidence:  match.confidence,
        reasoning:   match.reasoning,
        boundingBox: element.boundingBox,
      } : null,
      assertionResults:  [],
      businessRuleResult: null,
      healingEvents,
      screenshots: { fullPage: '', element: null },
      durationMs:  Date.now() - start,
      error,
    }
  }
}

// ── module-level helpers ──────────────────────────────────────────────────────

// Steps whose intent references a modal/drawer must only run when one is open.
// On sites that complete the action without a dialog, these steps fast-fail so
// the scheduler moves on and the difference shows up in the report.
function stepRequiresOpenDialog(intent: string): boolean {
  const lower = intent.toLowerCase()
  return lower.includes('modal') || lower.includes('drawer') || lower.includes('dialog')
}

// Returns true when a product drawer/modal is open — detected by finding an
// Add-to-Cart (or Add-to-Bag) button inside any visible dialog. Checks both
// standard ARIA role="dialog" and Walgreens' ReactModalPortal overlay pattern.
// Distinguishes the product picker from persistent sign-in overlays that carry
// role="dialog" but contain no cart/bag button.
async function productDialogWithCartButton(page: Page): Promise<boolean> {
  return page
    .locator('[role="dialog"]:not([aria-hidden="true"]) button, .ReactModalPortal button')
    .filter({ hasText: /add.*(cart|bag)/i })
    .first()
    .isVisible()
    .catch(() => false)
}

// Returns true when any role="dialog" OR ReactModalPortal overlay is visible —
// used for dismiss-modal steps where we only care if there is something to close.
async function anyDialogVisible(page: Page): Promise<boolean> {
  const ariaDialog = await page
    .locator('[role="dialog"]:not([aria-hidden="true"])')
    .first()
    .isVisible()
    .catch(() => false)
  if (ariaDialog) return true
  // Walgreens uses a ReactModalPortal pattern (no role="dialog" on the container).
  // Check whether the portal has any rendered children (i.e., a modal is open).
  return page
    .locator('.ReactModalPortal > *')
    .first()
    .isVisible()
    .catch(() => false)
}

// True when the step's purpose is to dismiss/close an open modal or drawer.
// These steps fast-pass when no dialog is present (the site already closed it)
// and proceed to find "Continue Shopping" / "X" when one is still open.
function stepIsDismissDialog(intent: string): boolean {
  const lower = intent.toLowerCase()
  return (
    (lower.includes('dismiss') || lower.includes('close') || lower.includes('continue shopping')) &&
    (lower.includes('modal') || lower.includes('drawer') || lower.includes('dialog'))
  )
}

// True when an element tag can receive fill() / pressSequentially() interactions.
// <a> and <div> etc. must never be targeted by fill steps — they navigate or do nothing.
function isFillableTag(tag: string): boolean {
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

// True when the step fills a text field (search box, form input, etc.)
function isTextEntryStep(intent: string): boolean {
  const lower = intent.toLowerCase()
  return (
    lower.includes('enter ') ||
    lower.includes('type ') ||
    lower.includes('fill in') ||
    lower.includes('fill out') ||
    (lower.includes('"') && (lower.includes(' into ') || lower.includes('search field') || lower.includes('text field')))
  )
}

// Returns true when the step is trying to submit a search form. Used as a guard
// for the Enter-key fallback: if clicking the matched element didn't navigate
// (e.g. the LLM picked an autocomplete container div instead of the submit button),
// we press Enter to submit the search and land on the actual results page.
function isSearchSubmitIntent(intent: string): boolean {
  const lower = intent.toLowerCase()
  return lower.includes('search') && (lower.includes('button') || lower.includes('submit'))
}

// Returns true when a URL belongs to a login or sign-in page.
function isLoginPage(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes('/login') || lower.includes('/signin') || lower.includes('/sign-in') || lower.includes('login.jsp')
}

// Steps whose intent starts with "validate" or "verify" are read-only checks that
// should not trigger any element interaction. They evaluate rules and assertions
// against the current page state without clicking anything, preventing accidental
// navigation away from the page being validated.
function isValidationOnlyStep(intent: string): boolean {
  const lower = intent.toLowerCase().trim()
  return lower.startsWith('validate') || lower.startsWith('verify')
}

function isNavigationToHome(intent: string): boolean {
  const lower = intent.toLowerCase()
  return (
    (lower.includes('navigate') || lower.includes('go to') || lower.includes('open')) &&
    lower.includes('home')
  )
}

async function waitForSettle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 })
  } catch {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
    } catch {
      // best-effort — continue regardless
    }
  }
}

