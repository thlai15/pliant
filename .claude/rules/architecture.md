# Architecture Rules

## Component Boundaries

Each component in `src/` has exactly one responsibility. Do not add functionality to a component
because it is "close enough." If a new responsibility does not fit cleanly, create a new component.

| Component | Owns | Does NOT own |
|---|---|---|
| `PlanRunner` | Orchestration, lifecycle | Parsing, matching, reporting |
| `StepScheduler` | Step selection logic | Interaction, assertion |
| `ExecutionLoop` | Per-step execution flow | Scheduling, reporting |
| `ElementExtractor` | DOM traversal, JS injection | LLM calls, matching |
| `SemanticMatcher` | LLM-based element scoring | DOM access, interaction |
| `AssertionEvaluator` | Structural expect evaluation | Business rules |
| `BusinessRuleEvaluator` | Formula evaluation, captures | Structural expects |
| `PlanParser` | Markdown parsing | Execution, validation |
| `ReportBuilder` | Data accumulation | HTML rendering |
| `HtmlReporter` | HTML generation | Data collection |

## Allowed Dependencies

```
PlanRunner
  → StepScheduler
  → ExecutionLoop
  → PlanParser
  → ReportBuilder
  → LLMClient (interface)
  → Playwright Page

ExecutionLoop
  → ElementExtractor
  → SemanticMatcher
  → AssertionEvaluator
  → BusinessRuleEvaluator
  → ScreenshotManager
  → ReportBuilder

SemanticMatcher
  → LLMClient (interface)

AssertionEvaluator
  → LLMClient (interface)

BusinessRuleEvaluator
  → SemanticMatcher
  → ElementExtractor
```

No component reaches "up" to its caller. No component imports from `runner/` from within
`locator/` or `report/`. Dependencies flow downward only.

## Playwright Boundary

Playwright `Page` and `Browser` objects must not cross the boundary into `locator/`, `llm/`, or
`report/`. They are confined to `runner/` and `ElementExtractor`. `ScreenshotManager` receives a
`Page` object because it must call `page.screenshot()`, but it does nothing else with the page.

`ElementExtractor` is the only component in `locator/` that holds a reference to `Page`.
`SemanticMatcher` receives only `ExtractedElement[]` — it never touches the page.

## LLM Boundary

All LLM calls go through the `LLMClient` interface. No component imports `ClaudeClient` or
`OllamaClient` directly. Only `PlanRunner` instantiates the concrete client (based on env var)
and passes it down.

Prompt strings are defined in `src/llm/prompts/` as exported template functions. No component
constructs prompt strings inline. This keeps prompts reviewable and testable in one place.

## No Shared Mutable State

Pliant is a sequential process. There is no global state. The `RunReport` being assembled is
owned by `ReportBuilder` and mutated only through its methods. No component holds a reference to
the partial report object directly.

## Environment Variables

Environment variables are read once at startup in `PlanRunner` and passed to components as typed
config objects. No component reads `process.env` directly except `PlanRunner`.

```typescript
interface RunConfig {
  targetUrl: string
  headless: boolean
  slowMo: number
  llmProvider: 'claude' | 'ollama'
  reportOutputDir: string
}
```

## Domain-Agnostic Design — Hard Rule

Pliant executes test plans against any website. **No source file may contain domain-specific
knowledge.** Specifically:

- **Prohibited in `src/llm/prompts/matchElement.ts`**: pre-filter functions or branches whose
  condition is based on e-commerce, shopping-cart, or retailer vocabulary — for example, functions
  named `isAddToCartIntent`, `isCartNavigationIntent`, `isModalAddToCartIntent`, or any function
  that checks strings like `"add to cart"`, `"shopping cart"`, `"checkout"`, `"product"`,
  `"buy"`, `"purchase"` to decide which candidates to pass to the LLM.

- **Permitted**: pre-filter functions whose condition is based on the *action type*, not the
  *domain content* — for example, `isTextEntryIntent` (based on the word "fill"/"type"/"enter"),
  `isDismissDialogIntent` (based on "close"/"dismiss" + "modal"/"dialog"),
  `isSearchButtonIntent` (based on "search" + "button"/"submit"). These describe what the user
  is *doing*, not what industry the application is in.

- **Permitted**: hints in the LLM system prompt (plain English guidance like "prefer Add to cart
  buttons over navigation links") — these are instructions to the model and do not add code
  branches.

- **Prohibited in `src/runner/ExecutionLoop.ts`**: guards or early-exit blocks that inspect the
  step intent for domain-specific strings to decide whether to call `interact()` or not. The
  execution loop must invoke `interact()` uniformly; let the LLM handle element selection.

If you find yourself writing a function that checks whether an intent mentions a cart, product,
store, or any other domain-specific noun — stop. That is a sign the pre-filter or guard is
domain-specific and violates this rule. Surface the information to the LLM via the system prompt
instead.

## Adding a New Retailer

Pliant requires zero code changes to run against a new retailer. The only change is
`TARGET_URL`. If a new retailer requires code changes to work, that is a bug in the locator
strategy or execution loop, not a feature request.

## Adding a New Validation Class

Currently two validation classes are implemented: structural and business logic. If a third class
(e.g. observational/baseline comparison) is added:

1. Define it in `docs/plan-format.md` first
2. Add a parser in `PlanParser`/`RulesParser`
3. Add an evaluator alongside `AssertionEvaluator` and `BusinessRuleEvaluator`
4. Wire it into `ExecutionLoop`
5. Add its result type to `StepReport`

Do not modify existing evaluators to handle new validation classes.
