# Testing Rules

## What Gets Tested

Pliant's framework components are unit-tested. The live execution against real retailer sites
is not unit-tested — it is validated by running the demo.

Priority order for test coverage:

1. `PlanParser` / `RulesParser` — pure parsers, fully unit-testable
2. Prompt template functions in `src/llm/prompts/` — pure functions, snapshot-testable
3. `BusinessRuleEvaluator` formula evaluation — pure logic, fully unit-testable
4. `StepScheduler` selection logic — testable with mock LLM client
5. `ElementExtractor` JS injection script — testable with a real Playwright page against a
   local HTML fixture
6. `SemanticMatcher` — testable with mock LLM client and fixture candidate arrays
7. `HtmlReporter` — testable with fixture `run.json` files

## Test Location and Naming

```
tests/
  unit/
    parser/
      PlanParser.test.ts
      RulesParser.test.ts
    prompts/
      matchElement.test.ts
      scoreSteps.test.ts
      evaluateAssertion.test.ts
    evaluator/
      BusinessRuleEvaluator.test.ts
    locator/
      ElementExtractor.test.ts    # uses Playwright + local HTML fixture
      SemanticMatcher.test.ts     # uses mock LLM
    scheduler/
      StepScheduler.test.ts       # uses mock LLM
    report/
      HtmlReporter.test.ts
  fixtures/
    plans/
      simple-cart.md              # minimal plan for parser tests
      full-cart.md                # the real demo plan
    html/
      search-results.html         # local HTML for ElementExtractor tests
      cart-page.html
    runs/
      site-a-run.json
      site-b-run.json
```

Test files are co-located with their fixture directories, not with `src/`.

## Mock LLM Client

```typescript
class MockLLMClient implements LLMClient {
  private responses: Map<string, string> = new Map()

  setResponse(promptSubstring: string, response: string): void {
    this.responses.set(promptSubstring, response)
  }

  async complete(prompt: LLMPrompt): Promise<LLMResponse> {
    for (const [key, value] of this.responses) {
      if (prompt.user.includes(key) || prompt.system.includes(key)) {
        return { content: value, inputTokens: 0, outputTokens: 0 }
      }
    }
    throw new Error(`MockLLMClient: no response configured for prompt: ${prompt.user.slice(0, 100)}`)
  }
}
```

Define this once in `tests/fixtures/MockLLMClient.ts`. Do not define mock clients inline in tests.

## Parser Tests

`PlanParser` tests cover:
- A plan with a single step and no expects
- A plan with multiple steps and multiple expects
- A step with a `rules` block
- A step with `stop: true`
- A step with `after:` dependencies
- A plan with multiple scenarios
- A plan with unknown/extra sections (must not throw)
- A plan with malformed step numbers (graceful handling)

Use `expect(result).toMatchSnapshot()` for parser output — the tree structure is stable and
snapshots are more readable than manual assertions for nested objects.

## Business Rule Evaluator Tests

Test the formula evaluator in isolation with pre-captured values. Do not test the capture step
(element extraction) in the same test.

```typescript
it('passes when subtotal equals sum of item prices within tolerance', () => {
  const rule: BusinessRule = {
    id: 'subtotal_validation',
    formula: 'subtotal == item_1_price + item_2_price',
    tolerance: 0.01,
    captures: [...]
  }
  const capturedValues = { subtotal: 18.94, item_1_price: 12.97, item_2_price: 5.97 }
  const result = evaluateFormula(rule, capturedValues)
  expect(result.pass).toBe(true)
  expect(result.evaluatedFormula).toBe('18.94 == 12.97 + 5.97')
})

it('fails when subtotal does not match beyond tolerance', () => {
  const capturedValues = { subtotal: 19.00, item_1_price: 12.97, item_2_price: 5.97 }
  const result = evaluateFormula(rule, capturedValues)
  expect(result.pass).toBe(false)
})
```

## ElementExtractor Tests

These tests use a real Playwright browser against local HTML fixtures. They run via
`playwright test` (the unit test runner configured in `playwright.config.ts`).

```typescript
test('extracts button with click listener', async ({ page }) => {
  await page.goto(`file://${path.resolve('tests/fixtures/html/search-results.html')}`)
  const elements = await extractor.extract(page)
  const addToCart = elements.find(e => e.text === 'Add to cart')
  expect(addToCart).toBeDefined()
  expect(addToCart!.events).toContain('click')
  expect(addToCart!.region).toBe('main')
})
```

HTML fixtures in `tests/fixtures/html/` should be minimal — only the markup needed to test the
specific scenario. Do not use real retailer HTML (legal/stability issues).

## Prompt Snapshot Tests

Prompt template functions are pure — they take inputs and return `LLMPrompt` objects. Test that
the generated prompt contains the right content:

```typescript
it('includes all candidates in the user prompt', () => {
  const candidates = [mockElement(0, 'Add to cart'), mockElement(1, 'Save for later')]
  const prompt = matchElementPrompt('click add to cart button', candidates)
  expect(prompt.user).toContain('Add to cart')
  expect(prompt.user).toContain('Save for later')
  expect(prompt.system).toContain('Return a JSON object only')
})
```

Use `toMatchSnapshot()` sparingly for prompts — prefer explicit content checks so test failures
point to the specific problem.

## What Not To Test

- The Anthropic API itself (integration tests, out of scope)
- The Ollama API
- Real retailer sites
- The HTML report's visual appearance (screenshot too brittle)
- Playwright's own browser automation (trust the library)

## Running Tests

```bash
# All unit tests
npm test

# Type check alongside tests (do both in CI)
npx tsc --noEmit && npm test

# Specific test file
npx playwright test tests/unit/parser/PlanParser.test.ts

# Watch mode during development
npx playwright test --watch
```
