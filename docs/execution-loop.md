# Execution Loop

## Overview

The execution loop is the heart of Pliant. It processes one step at a time, performing the
interaction, evaluating assertions, and handling failure recovery — all within the same loop
iteration. There is no separate healing phase.

## Loop Pseudocode

```
run(plan, page):
  inject listener tracker into page
  navigate to TARGET_URL
  scheduler = StepScheduler(plan.steps)

  while scheduler.hasPending():
    step = scheduler.next(pageContext(page))

    if step is null:
      if tryAdvancePage(page):        # look for Next/Continue
        continue
      else:
        markRemainingFailed(scheduler)
        break

    result = executeStep(step, page)
    scheduler.markComplete(step, result)
    reportBuilder.record(step, result)

    if step.stop == true:
      break


executeStep(step, page):
  candidates = ElementExtractor.extract(page)
  match = SemanticMatcher.match(step.intent, candidates)

  interactionResult = interact(match, step, page)

  if interactionResult.failed:
    return StepResult.failed(interactionResult.error)

  assertionResults = AssertionEvaluator.evaluate(step.expects, page, candidates)

  if step.rules:
    ruleResult = BusinessRuleEvaluator.evaluate(step.rules, page)
    assertionResults.push(ruleResult)

  screenshot = ScreenshotManager.capture(page, match.element)

  return StepResult(
    outcome: allPassed(assertionResults) ? PASS : FAIL,
    match,
    assertionResults,
    screenshot
  )
```

## StepScheduler

The scheduler treats the plan as an ordered preference list, not a strict sequence. Each call to
`next()` scores all pending steps against the current page context and returns the best match.

### Page Context

```typescript
interface PageContext {
  url: string
  title: string
  headings: string[]      // all h1-h3 text visible on page
  landmarkLabels: string[] // aria-label values on main, nav, section landmarks
}
```

### Scoring Prompt

The LLM receives all pending steps and the page context. It returns a JSON array of
`{ stepId, score }` pairs where score is 0.0–1.0. The scheduler takes the highest scoring step
above the `SCHEDULER_MIN_SCORE` threshold (default: 0.5).

The prompt instructs the LLM to score based on:
- Whether the step action is plausible given the current URL (e.g. a "checkout" step scores low
  on a search results page)
- Whether any page headings or landmark labels match the step's domain
- Whether the step is a natural continuation of the steps already completed

### Forcing Sequential Steps

Some steps must be sequential regardless of page state — for example, you cannot "add to cart"
before "search." The plan supports an optional `after: [stepId, ...]` field on a step to express
this constraint. The scheduler never selects a step whose `after` dependencies have not been
completed, regardless of its score.

## Interaction Mechanics

### Selector Fast Path

Every `ExtractedElement` carries a generated CSS selector from the extraction run. On replay, the
loop attempts this selector first via `page.locator(selector).click()`. If it resolves to exactly
one visible element, the interaction proceeds immediately without an LLM call. This is the common
case on the second and subsequent runs against the same retailer after the first run has resolved
and cached the selector.

### Semantic Path

When the fast path fails (element not found, multiple matches, or first run with no cached
selector), the loop falls back to `SemanticMatcher`. The matcher sends the full candidate list
to the LLM and receives:

```typescript
interface MatchResult {
  elementIndex: number    // index into the candidates array
  confidence: number      // 0.0–1.0
  reasoning: string       // brief explanation, recorded in the report
  alternativeIndices: number[]  // runner-up candidates for debugging
}
```

### Input Steps

For steps that require text input (filling a form field), the step intent includes the value:
`"Enter 'Clorox toilet bowl cleaner' into the search field"`. The matcher identifies the target
input element. The loop then calls `page.fill(selector, value)` with the value extracted from the
step intent by the LLM as part of the match response.

```typescript
interface MatchResult {
  // ...existing fields...
  fillValue?: string   // populated when the step involves text input
}
```

## Assertion Evaluation

### Structural Expects

Each `expect:` line on a step is a natural language assertion. After the interaction settles
(Playwright's auto-wait), the evaluator sends the expect string plus the current page's candidate
elements to the LLM.

Example prompt input:
```
Expect: "At least one Clorox toilet bowl cleaner product is visible in the results"

Current page elements (filtered to visible text-bearing elements):
- main > search-results > product-card: "Clorox ToiletWand Disposable Toilet Cleaning System"
- main > search-results > product-card: "Clorox Toilet Bowl Cleaner with Bleach"
- main > search-results > product-card: "Lysol Power Toilet Bowl Cleaner"
...
```

The LLM returns:
```json
{ "pass": true, "reasoning": "Second result matches Clorox toilet bowl cleaner" }
```

### Business Rule Evaluation

See `docs/plan-format.md` for the rules block spec. The evaluator:

1. For each `capture` entry, calls `SemanticMatcher` to find the element matching the semantic
   description within the specified region
2. Extracts the element's text content
3. Parses the text as a number (strips `$`, `,`, whitespace)
4. Substitutes all captured values into the formula string
5. Evaluates the formula using a safe expression evaluator (no `eval()`)
6. Applies tolerance: `Math.abs(lhs - rhs) <= tolerance`

If a capture target cannot be found, the rule fails with reason `"Could not locate [name] on page"`.

The captured values and formula evaluation are included in the report for transparency.

## Tier 2: Next/Continue Escape Valve

When `SemanticMatcher` returns confidence below `MIN_CONFIDENCE`, or when `StepScheduler` returns
`null`, the loop scans for forward-progression affordances before giving up.

### Forward Affordance Scan

The loop calls `ElementExtractor.extractForwardAffordances(page)` which runs a targeted JS query
for elements whose visible text matches any of:

```
next, continue, proceed, skip, go, submit, place order, review order, keep shopping →
```

The list is case-insensitive and partial-match. The first match in reading order (top-to-bottom,
left-to-right) is clicked. If multiple matches exist, the one in the `main` region is preferred.

After clicking a forward affordance, the loop:
1. Waits for navigation or DOM settle
2. Re-runs `StepScheduler.next()` with the updated page context
3. Attempts the newly selected step

Forward affordance clicks are logged as healing events in the report with type `FORWARD_ADVANCE`.

### Limits

The loop tracks consecutive forward advances. If 3 consecutive advances produce no completed steps,
the run is marked stuck and remaining steps are failed. This prevents infinite loops on sites with
unexpected navigation patterns.

## Error Handling

| Situation | Behaviour |
|---|---|
| Playwright navigation timeout | Step fails; loop continues |
| LLM API error | Retry once with 2s delay; if second fails, step fails |
| Element found but interaction throws | Log error; attempt forward affordance scan |
| Business rule capture fails | Rule assertion fails with `CAPTURE_FAILED`; step marked fail |
| `stop: true` reached | Run marked complete; remaining steps recorded as skipped |
| 3 consecutive stuck advances | Run marked stuck; remaining steps failed |

## Timing

- After each interaction: `page.waitForLoadState('networkidle', { timeout: 5000 })`, falling back
  to `domcontentloaded` on timeout
- Between steps: no artificial delay unless `SLOW_MO` is set (for demo purposes)
- LLM calls: no timeout enforced by the loop — rely on the LLM client's own timeout (default 30s)
