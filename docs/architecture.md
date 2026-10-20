# Architecture

## System Overview

Pliant executes a plain-language test plan directly against a live browser. There is no
intermediate test script generation step. The LLM reasons about the live page state at runtime —
finding elements, evaluating assertions, recovering from failures — all within the same execution
loop.

```
┌─────────────────────────────────────────────────────────────┐
│                        PlanRunner                           │
│  reads plan → creates Page → drives ExecutionLoop          │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                      ExecutionLoop                          │
│                                                             │
│  for each step selected by StepScheduler:                   │
│    1. ElementExtractor → candidate elements from live DOM   │
│    2. SemanticMatcher  → find best element for step intent  │
│    3. Playwright       → perform the interaction            │
│    4. AssertionEval    → evaluate expects on the step       │
│    5. ReportBuilder    → record outcome + screenshot        │
│                                                             │
│  on element not found:                                      │
│    → Tier 2: scan for Next/Continue affordances             │
│    → advance page, re-evaluate                              │
│                                                             │
│  on low confidence match:                                   │
│    → log healing event, proceed with best candidate         │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### PlanRunner (`src/runner/PlanRunner.ts`)

Entry point. Responsibilities:
- Parse the plan file using `PlanParser`
- Read `TARGET_URL` from environment
- Launch Playwright browser and create `Page`
- Inject the event listener tracker script before page navigation
- Instantiate `ExecutionLoop` and hand it the plan + page
- Collect the final run result and pass to `ReportBuilder`
- Exit with code 0 (all steps passed) or 1 (any step failed)

### StepScheduler (`src/runner/StepScheduler.ts`)

Decides which pending step to attempt next given the current page state. Responsibilities:
- Maintain a set of pending steps and a set of completed steps
- On each call to `next(pageContext)`, ask the LLM to score all pending steps against the
  current page URL, page title, and visible heading text
- Return the highest-scoring pending step
- If no step scores above the minimum threshold, return `null` (triggers stuck handling)

This is what enables the same plan to run on retailers with different checkout page orderings.
Step 9 (contact info), Step 10 (shipping address), and Step 11 (payment) may appear in any order
depending on the retailer. `StepScheduler` picks the right one each time.

### ExecutionLoop (`src/runner/ExecutionLoop.ts`)

The per-step execution engine. For each step:

1. Call `ElementExtractor.extract(page)` to get all interactive candidates
2. Call `SemanticMatcher.match(stepIntent, candidates)` to get ranked matches
3. If top match confidence >= `CONFIDENCE_THRESHOLD` (default 0.75): interact via Playwright
4. If top match confidence < `CONFIDENCE_THRESHOLD`:
   - Log a healing event (semantic fallback used)
   - Proceed with top candidate anyway if confidence >= `MIN_CONFIDENCE` (default 0.4)
   - If below `MIN_CONFIDENCE`: trigger Tier 2 (Next/Continue scan)
5. After interaction: evaluate structural expects via `AssertionEvaluator`
6. If step has a `rules` block: evaluate business logic via `BusinessRuleEvaluator`
7. Record outcome via `ReportBuilder`

**stop: true** — if a step has `stop: true`, the loop verifies the step's expects are met,
records a pass, then halts execution and marks the run as complete. No further steps are attempted.

### ElementExtractor (`src/locator/ElementExtractor.ts`)

Injects JavaScript into the page to extract interactive elements. Does not use Playwright's
locator APIs as the primary mechanism. Responsibilities:
- Inject the listener tracker script at page load (wraps `addEventListener`)
- On extraction: call `page.evaluate()` with the extraction script
- Return an array of `ExtractedElement` objects

The extraction script traverses the DOM to find:
- All elements with semantic roles: `button`, `a`, `input`, `select`, `textarea`
- All elements with tracked event listeners (click, mousedown, keydown)
- All elements with inline event handlers (`onclick`, `onkeydown`, etc.)

For each element found, the extraction script builds:
- `path`: up to 3 levels of ancestor context, e.g. `"Cart Summary > Item Row > Remove"`
- `label`: aria-label, associated `<label>` text, placeholder, or button text
- `tag` and `role`
- `events`: event types bound to this element
- `region`: nearest landmark ancestor (`main`, `nav`, `aside`, `header`, `footer`)
- `boundingBox` and `relativePosition`
- `siblings`: text content of adjacent elements for disambiguation
- `selector`: a generated CSS selector as a fast-path hint for subsequent interactions

### SemanticMatcher (`src/locator/SemanticMatcher.ts`)

Sends candidates to the LLM and gets back a ranked match. Responsibilities:
- Format the step intent and candidate list into a structured prompt
- Call `LLMClient.complete(prompt)`
- Parse the response into a `MatchResult` with `elementIndex` and `confidence`
- Cache resolved matches per step ID per run (avoid redundant LLM calls on retry)

Scoring heuristic encoded in the prompt:
- Element label/text match to step intent is the primary signal (highest weight)
- Path ancestor match adds supporting evidence with diminishing weight per level
- Element type consistency (step says "click button", candidate is a div with click listener)
- Visual region consistency (checkout steps should be in `main`, not `nav`)

### LLMClient (`src/llm/LLMClient.ts`)

Interface only. Two implementations:
- `ClaudeClient`: calls Anthropic API with `claude-sonnet-4-20250514`
- `OllamaClient`: calls local Ollama endpoint

Selected by `LLM_PROVIDER` environment variable. Instantiated once in `PlanRunner` and passed
down. Never instantiate an LLM client inside a component — always receive it as a constructor
parameter.

### PlanParser (`src/parser/PlanParser.ts`)

Parses Playwright Planner Markdown into a `TestPlan` domain object. Responsibilities:
- Parse scenario title, step number, step text, and `expect:` lines
- Detect and extract `rules` fenced code blocks
- Pass rules block content to `RulesParser`
- Return a fully typed `TestPlan` with `Scenario[]` and `Step[]`

The parser is lenient — it does not fail on unrecognised sections. Unknown content is ignored.
This allows the plan to contain Playwright Planner standard content (seeds, prerequisites) without
breaking the runner.

### RulesParser (`src/parser/RulesParser.ts`)

Parses the YAML content of a `rules` fenced block into a `BusinessRule` object containing the
formula string and capture specifications. See `docs/plan-format.md` for the full spec.

### AssertionEvaluator (`src/runner/AssertionEvaluator.ts`)

Evaluates structural `expect:` lines after a step's interaction. For each expect string:
- Extracts the current page's candidate elements (reuses last extraction if page has not changed)
- Sends the expect string + page state to the LLM
- Receives a pass/fail + brief reasoning string
- Returns an `AssertionResult`

### BusinessRuleEvaluator (`src/runner/BusinessRuleEvaluator.ts`)

Evaluates `rules` block assertions. For each capture spec:
- Calls `ElementExtractor` with semantic target from the capture spec
- Extracts the text value and parses it as a number (strips currency symbols)
- Substitutes captured values into the formula
- Evaluates the formula (safe expression evaluator, not `eval()`)
- Returns pass/fail + the captured values for the report

### ReportBuilder (`src/report/ReportBuilder.ts`)

Accumulates run data. For each step:
- Full-page screenshot (taken after the interaction settles)
- Cropped screenshot of the interacted element (from bounding box)
- Step outcome: pass / fail / skipped / healed
- Which locator strategy was used: `direct` (selector hit) or `semantic` (LLM resolved)
- Assertion results
- Healing events (what the LLM chose and why)

Persists run data as JSON to `REPORT_OUTPUT_DIR/<run-id>/run.json`.

### HtmlReporter (`src/report/HtmlReporter.ts`)

Reads two `run.json` files and renders a side-by-side HTML comparison report. The report is a
self-contained HTML file — no server required, suitable for sharing.

## Data Flow for a Single Step

```
Page state (live DOM)
        │
        ▼
ElementExtractor.extract(page)
        │ ExtractedElement[]
        ▼
SemanticMatcher.match(stepIntent, candidates)
        │ MatchResult { elementIndex, confidence, reasoning }
        ▼
Playwright interaction (click / fill / press)
        │
        ▼
AssertionEvaluator.evaluate(expects, page)
        │ AssertionResult[]
        ▼
ReportBuilder.recordStep(...)
```

## Healing Decision Tree

```
Attempt step
    │
    ├─ Selector fast-path hit? → interact → done
    │
    ├─ Confidence >= 0.75? → interact (log: direct semantic match) → done
    │
    ├─ Confidence >= 0.40? → interact (log: healing event, low confidence) → done
    │
    ├─ Confidence < 0.40?
    │     └─ Scan for Next/Continue/Proceed affordances
    │           ├─ Found? → click → re-evaluate step from top
    │           └─ Not found? → mark step FAILED, continue to next step
    │
    └─ StepScheduler returns null (no step matches current page)?
          └─ Scan for Next/Continue/Proceed affordances → advance → retry scheduler
```

## Threading and Concurrency

Pliant is single-threaded per run. Each retailer run is a sequential Node.js process.
Parallel multi-retailer runs are achieved by running two separate processes with different
`TARGET_URL` values, producing separate `run.json` files that `HtmlReporter` then combines.
