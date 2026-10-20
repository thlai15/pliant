/// <reference lib="dom" />
import { BrowserDriver } from '@driver/BrowserDriver'
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
import { ClickInterceptedError, ExecutionContextDestroyedError } from '@types-local/errors'
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

  async run(plan: TestPlan, driver: BrowserDriver, targetUrl: string): Promise<void> {
    for (const scenario of plan.scenarios) {
      logger.info(`Running scenario: ${scenario.title}`)
      await this.runScenario(scenario, driver, targetUrl)
    }
  }

  // ── scenario loop ───────────────────────────────────────────────────────────

  private async runScenario(scenario: Scenario, driver: BrowserDriver, targetUrl: string): Promise<void> {
    await driver.goto(targetUrl)
    await driver.waitForSettle()

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

      logger.info(`Attempting step ${step.id} on ${await driver.currentUrl()}: ${step.intent}`)
      const result = isNavigationToHome(step.intent)
        ? await this.executeHomeNavigation(driver, targetUrl)
        : await this.executeStep(step, driver)

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

      const recovered = await this.recover(step, scheduler, driver)
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

  private async executeStep(step: Step, driver: BrowserDriver): Promise<StepResult> {
    const start = Date.now()
    const healingEvents: HealingEvent[] = []

    // Pure validation steps ("validate X", "verify Y") with a business rules block
    // should not interact with any page element — they only read page state to check
    // assertions and evaluate the formula. Forcing an interaction risks navigating away
    // from the page being validated (e.g. accidentally clicking the Wishlist link).
    if (isValidationOnlyStep(step.intent) && step.rules !== null) {
      await driver.waitForSettle()
      const freshCandidates = await this.extractor.extract(driver)
      const pageText = await readPageText(driver)
      const assertionResults = await this.assertionEvaluator.evaluate(
        step.expects, freshCandidates, await driver.currentUrl(), false, pageText)
      const businessRuleResult = await this.ruleEvaluator.evaluate(step.rules, driver)
      const screenshots = await this.screenshotManager.capture(driver, null, step.number)
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
      const dialogOpen = await anyDialogVisible(driver)
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
      const productDialogOpen = await productDialogWithCartButton(driver)
      if (!productDialogOpen) {
        logger.info(`Step ${step.id} requires an open product dialog — none present, marking complete`)
        return this.failedResult(start, null, null, 'SEMANTIC', healingEvents,
          'Step requires an open product modal/dialog with Add-to-Cart, but none is present')
      }
    }

    let candidates = await this.extractor.extract(driver).catch(async (err: unknown) => {
      // SPA navigation mid-evaluate destroys the execution context. Re-settle and retry once.
      if (err instanceof ExecutionContextDestroyedError) {
        logger.warn('Extraction context destroyed by navigation — re-settling and retrying')
        await driver.waitForSettle()
        return this.extractor.extract(driver)
      }
      throw err
    })
    logger.debug(`Extracted ${candidates.length} candidates`)

    // If very few elements found, the page may still be on a redirect or security-check
    // intermediate page. Wait up to 8 s for the real page to load, then retry once.
    if (candidates.length < 5) {
      logger.debug('Too few candidates — waiting for page to fully settle')
      await new Promise<void>(r => setTimeout(r, 5000))
      await driver.waitForSettle()
      candidates = await this.extractor.extract(driver)
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

    const interactOutcome = await this.interact(matchedEl, match.fillValue, driver, step.intent)

    if (!interactOutcome.success) {
      return this.failedResult(start, match, matchedEl, locatorStrategy, healingEvents,
        interactOutcome.error ?? 'Interaction failed')
    }

    await driver.waitForSettle()

    // For click interactions, wait up to 8s for a product dialog/drawer to appear.
    // Some sites make a slow AJAX call after an Add-to-Cart click before rendering a
    // picker modal, which can outlast the networkidle wait above. The combined
    // ARIA-dialog + ReactModalPortal selector covers standard dialogs and portal-based
    // overlays. Best-effort; timeout is swallowed.
    //
    // Optimization: first check if the dialog starts to appear within 500ms. If it does
    // not, skip the full 8s wait so freshCandidates is captured while page notifications
    // (e.g. "item added" banners) are still visible. Slow dialogs still show their
    // container within 500ms, so the full wait applies in those cases.
    if (match.fillValue === null) {
      const dialogAppeared = await driver.waitForVisible(DIALOG_BUTTON_SELECTOR, 500, { hasText: ADD_TO_CART_TEXT })
      if (dialogAppeared) {
        await driver.waitForVisible(DIALOG_BUTTON_SELECTOR, 7500, { hasText: ADD_TO_CART_TEXT })
      }
    }

    // ── assertions ─────────────────────────────────────────────────────────

    const freshCandidates = await this.extractor.extract(driver)
    const productDialogOpen = match.fillValue === null ? await productDialogWithCartButton(driver) : false
    const pageText = await readPageText(driver)
    const assertionResults = await this.assertionEvaluator.evaluate(
      step.expects, freshCandidates, await driver.currentUrl(), productDialogOpen, pageText)

    let businessRuleResult: BusinessRuleReport | null = null
    if (step.rules !== null) {
      businessRuleResult = await this.ruleEvaluator.evaluate(step.rules, driver)
    }

    const screenshots = await this.screenshotManager.capture(driver, matchedEl, step.number)

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

  // Optional pause between steps (HUMAN_TIMING=true), for apps that need time to
  // settle between actions or when watching a run. Off by default.
  private async stepJitter(): Promise<void> {
    if (!this.humanTiming.enabled) return
    const { stepDelayMin, stepDelayMax } = this.humanTiming
    const delay = stepDelayMin + Math.floor(Math.random() * (stepDelayMax - stepDelayMin + 1))
    await new Promise<void>(r => setTimeout(r, delay))
  }

  private async executeHomeNavigation(driver: BrowserDriver, targetUrl: string): Promise<StepResult> {
    const start = Date.now()
    const current = (await driver.currentUrl()).replace(/\/$/, '')
    const target  = targetUrl.replace(/\/$/, '')

    if (!current.startsWith(target)) {
      logger.info(`Not at target URL — navigating to ${targetUrl}`)
      await driver.goto(targetUrl)
      await driver.waitForSettle()
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
    driver: BrowserDriver,
    intent: string = '',
  ): Promise<{ success: boolean; error: string | null }> {
    const selector = element.selector
    try {
      if (fillValue !== null) {
        if (element.tag === 'select') {
          // selectOption() is the correct API for <select> elements; fill() does nothing.
          // Try exact value match, then exact label, then partial/case-insensitive label
          // so "CA" matches options labeled "CA" OR "California" and vice-versa.
          await this.selectOption(selector, fillValue, driver)
        } else {
          // Type one character at a time so each fires its own keydown/keypress/keyup
          // events, as a real user's typing does. Autocomplete, input masks and
          // validation handlers often listen for these and ignore a value set in one go.
          // If an overlay (e.g. a product picker modal from the previous step) is
          // still open and intercepts the click, press Escape to dismiss it first.
          try {
            await driver.click(selector, { timeoutMs: 5000 })
          } catch (fillClickErr) {
            if (!(fillClickErr instanceof ClickInterceptedError)) throw fillClickErr
            logger.debug('Overlay blocking fill-click — pressing Escape to dismiss')
            await driver.pressKey('Escape')
            await new Promise<void>(r => setTimeout(r, 600))
            await driver.click(selector, { timeoutMs: 5000 })
          }
          await driver.typeText(selector, fillValue, 85 + Math.floor(Math.random() * 65))
        }
      } else {
        const urlBefore = await driver.currentUrl()
        // Move the pointer onto the element before clicking so hover-driven UI
        // (menus, tooltips, lazily attached handlers) reacts as it would for a user.
        const box = await driver.boundingBox(selector)
        if (box !== null) {
          await driver.moveMouse(
            box.x + Math.round(box.width  * (0.3 + Math.random() * 0.4)),
            box.y + Math.round(box.height * (0.3 + Math.random() * 0.4)),
            3 + Math.floor(Math.random() * 5),
          )
        }
        // Three-stage click recovery for overlays that intercept pointer events:
        //  1. Regular click (5 s timeout)
        //  2. Escape + wait + retry (5 s) — dismisses one overlay layer
        //  3. Force click — bypasses overlay position check entirely as last resort
        //     (avoids pressing Escape twice, which can clear search field text)
        try {
          await driver.click(selector, { timeoutMs: 5000 })
        } catch (firstError) {
          if (!(firstError instanceof ClickInterceptedError)) throw firstError
          logger.debug('Modal overlay blocking click (attempt 2) — pressing Escape to dismiss')
          await driver.pressKey('Escape')
          await new Promise<void>(r => setTimeout(r, 600))
          try {
            await driver.click(selector, { timeoutMs: 5000 })
          } catch {
            // Force-click bypasses overlay position check without another Escape.
            logger.debug('Still blocked after Escape — using force click')
            await driver.click(selector, { force: true, timeoutMs: 5000 })
          }
        }
        // Give SPA/server navigation 200 ms to update the URL, then wait for
        // the new page to settle so assertions don't run against the old page.
        // When the URL is unchanged, also wait for networkidle so AJAX-driven DOM
        // updates (add-to-cart notifications, accordion panels) are rendered before
        // assertions capture freshCandidates and pageText.
        await new Promise<void>(r => setTimeout(r, 200))
        if (await driver.currentUrl() !== urlBefore) {
          await driver.waitForSettle()
        } else if (isSearchSubmitIntent(intent)) {
          // URL unchanged after clicking what should be a search submit button.
          // The LLM may have matched an autocomplete container, a review radio button,
          // or another non-submit element. Re-focus the search input (detected as the
          // first text/search input on the page that has a value) then press Enter —
          // this reliably submits the search regardless of where focus currently is.
          logger.debug('Search-submit click did not navigate — pressing Enter as fallback')
          await driver.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
              'input[type="text"], input[type="search"], input:not([type])',
            ))
            const filled = inputs.find(el => el.value.trim().length > 0)
            if (filled !== undefined) filled.focus()
          })
          await driver.pressKey('Enter')
          await new Promise<void>(r => setTimeout(r, 300))
          if (await driver.currentUrl() !== urlBefore) {
            await driver.waitForSettle()
          }
        } else {
          // URL unchanged and not a search submit: wait for AJAX-driven DOM updates
          // (add-to-cart notifications, accordion panels) before assertions run.
          await driver.waitForSettle(2000)
        }
        // Guard against unexpected login-page redirects (some quick-add flows silently
        // redirect to login). Skip the check when the intent explicitly mentions
        // login/checkout — those steps intentionally navigate to a login-gated page.
        const urlAfter = await driver.currentUrl()
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
      logger.warn(`Interaction failed "${selector}": ${String(error)}`)
      return { success: false, error: String(error) }
    }
  }

  // Fills a <select> element with the best-matching option, trying:
  //   1. Exact value attribute match  (e.g. value="CA")
  //   2. Exact label text match       (e.g. "California")
  //   3. Partial/case-insensitive label (e.g. "CA" matches "California"; "California" matches "CA")
  // This handles the state-abbreviation vs full-name ambiguity across retailers.
  private async selectOption(
    selector: string,
    value: string,
    driver: BrowserDriver,
  ): Promise<void> {
    const strategies: Array<() => Promise<unknown>> = [
      () => driver.selectOption(selector, { value }),
      () => driver.selectOption(selector, { label: value }),
      async () => {
        // Collect all option texts and find the best partial/case-insensitive match.
        const optionTexts = await driver.optionLabels(selector)
        const lower = value.toLowerCase()
        const match =
          optionTexts.find(t => t.toLowerCase() === lower) ??
          optionTexts.find(t => t.toLowerCase().startsWith(lower)) ??
          optionTexts.find(t => lower.startsWith(t.toLowerCase().slice(0, 2))) ??
          optionTexts.find(t => t.toLowerCase().includes(lower))
        if (match === undefined) {
          throw new Error(`No <option> matching "${value}" in select (options: ${optionTexts.slice(0, 5).join(', ')})`)
        }
        await driver.selectOption(selector, { label: match })
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
        await driver.waitForSettle()
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
    driver: BrowserDriver,
  ): Promise<boolean> {
    // Phase 1: page-state-driven routing via element hints
    const candidates = await this.extractor.extract(driver).catch((): ExtractedElement[] => [])
    const applicable = scheduler.findByPageState(candidates)
      .filter(s => s.id !== target.id)
      .sort((a, b) => a.number - b.number)

    if (applicable.length > 0) {
      logger.info(`Recovery: ${applicable.length} page-state-applicable step(s) for target ${target.id}`)
      for (const step of applicable) {
        logger.info(`Recovery: executing applicable step ${step.id} (page-state match)`)
        const result = await this.executeStep(step, driver)
        scheduler.markComplete(step)
        this.reportBuilder.recordStep(step, result)
        logger.info(`Applicable step ${step.id} → ${result.outcome}`)
      }
      return true
    }

    // Phase 2: adjacent step routing and forward affordances
    const adjacent = scheduler.peekAdjacent(target.number, 2)
      .filter(s => s.number < target.number)
    const affordances = await this.extractor.extractForwardAffordances(driver)
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
      const result = await this.executeStep(adjacentStep, driver)
      scheduler.markComplete(adjacentStep)
      this.reportBuilder.recordStep(adjacentStep, result)
      logger.info(`Adjacent step ${adjacentStep.id} → ${result.outcome}`)
      return true
    }

    if (affordance !== null) {
      try {
        await driver.click(affordance.selector)
        logger.info(`Recovery: advanced page via "${affordance.text.slice(0, 60)}"`)
        await driver.waitForSettle()
        return true
      } catch (error) {
        logger.warn(`Recovery advance failed: ${String(error)}`)
        return false
      }
    }

    return false
  }

  private async dismissOpenDialog(driver: BrowserDriver): Promise<void> {
    const open = await driver.isVisible('[role="dialog"][aria-modal="true"]:not([aria-hidden="true"])')
    if (open) {
      logger.debug('Dismissing carry-over modal dialog')
      await driver.pressKey('Escape')
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
// standard ARIA role="dialog" and the ReactModalPortal overlay pattern.
// Distinguishes the product picker from persistent sign-in overlays that carry
// role="dialog" but contain no cart/bag button.
const DIALOG_BUTTON_SELECTOR = '[role="dialog"]:not([aria-hidden="true"]) button, .ReactModalPortal button'
const ADD_TO_CART_TEXT = /add.*(cart|bag)/i

async function productDialogWithCartButton(driver: BrowserDriver): Promise<boolean> {
  return driver.isVisible(DIALOG_BUTTON_SELECTOR, { hasText: ADD_TO_CART_TEXT })
}

// Returns true when any role="dialog" OR ReactModalPortal overlay is visible —
// used for dismiss-modal steps where we only care if there is something to close.
async function anyDialogVisible(driver: BrowserDriver): Promise<boolean> {
  const ariaDialog = await driver.isVisible('[role="dialog"]:not([aria-hidden="true"])')
  if (ariaDialog) return true
  // Some React sites render modals in a ReactModalPortal with no role="dialog".
  // Check whether the portal has any rendered children (i.e., a modal is open).
  return driver.isVisible('.ReactModalPortal > *')
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

// Visible page text (first 5000 chars) gives the assertion prompt product names,
// prices and other non-interactive content.
async function readPageText(driver: BrowserDriver): Promise<string> {
  return driver.evaluate(() => (document.body.innerText ?? '').slice(0, 5000)).catch(() => '')
}

