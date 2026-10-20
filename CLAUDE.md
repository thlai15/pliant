# Pliant — Claude Code Project Guide

## What This Is

Pliant is a plan-driven, self-healing test execution framework. It reads a test plan written in
Playwright Planner Markdown format and executes it directly against a live application — no
intermediate test script generation step. Self-healing is built into the execution loop, not bolted
on as a post-failure repair stage.

The primary demo: a single shopping cart test plan that runs without modification on two public
demo stores (Tricentis Demo Web Shop and nopCommerce), with a subtotal validation that reads
actual prices from the UI at runtime. Domain knowledge belongs in the plan, not in `src/`
(see the domain-agnostic rule in `.claude/rules/architecture.md`).

## Repository Layout

```
pliant/
├── CLAUDE.md                    # this file
├── CLAUDE_SETUP.md              # project setup prompt for new environments
├── playwright.config.ts
├── tsconfig.json
├── package.json
├── plans/
│   └── shopping-cart.md         # the demo test plan
├── src/
│   ├── runner/
│   │   ├── PlanRunner.ts        # top-level orchestrator
│   │   ├── StepScheduler.ts     # out-of-order step matching
│   │   └── ExecutionLoop.ts     # per-step execution and healing
│   ├── locator/
│   │   ├── ElementExtractor.ts  # JS injection, DOM traversal
│   │   ├── SemanticMatcher.ts   # LLM-based candidate scoring
│   │   └── types.ts             # ExtractedElement and related types
│   ├── llm/
│   │   ├── LLMClient.ts         # pluggable LLM interface
│   │   ├── ClaudeClient.ts      # Claude API implementation
│   │   ├── OllamaClient.ts      # Ollama implementation (local models)
│   │   └── prompts/             # one file per prompt template
│   ├── parser/
│   │   ├── PlanParser.ts        # Playwright Planner Markdown parser
│   │   └── RulesParser.ts       # business rules block parser
│   ├── report/
│   │   ├── ReportBuilder.ts     # assembles run data into report model
│   │   ├── ScreenshotManager.ts # captures and crops screenshots
│   │   └── HtmlReporter.ts      # renders side-by-side HTML report
│   └── types/
│       └── index.ts             # shared domain types
├── tests/
│   └── unit/                    # unit tests for parser, matcher, etc.
└── docs/
    ├── architecture.md
    ├── execution-loop.md
    ├── locator-strategy.md
    ├── plan-format.md
    └── report-format.md
```

## Architecture in One Paragraph

`PlanRunner` reads the plan, creates a `Page` instance for the target retailer, and hands control
to `ExecutionLoop`. For each step, `ElementExtractor` injects JavaScript into the live page to
build a candidate list of interactive elements with semantic metadata. `SemanticMatcher` sends that
list plus the step intent to an LLM and gets back the best matching element. Playwright then
performs the interaction. After the interaction, the loop evaluates any `expect` assertions on the
step. For steps with a `rules` block, `RulesParser` provides the formula and `ElementExtractor`
captures the named values from the UI; the LLM evaluates the formula. The
`StepScheduler` tracks which steps are pending and selects the next best match for the current page
state, enabling out-of-order execution across retailers with different checkout flows.
`ReportBuilder` records every step outcome, screenshot, and healing event; `HtmlReporter` renders
the side-by-side comparison report.

## Key Design Decisions — Do Not Reverse Without Discussion

1. **No test script generation.** The plan drives execution directly. The LLM reasons at runtime,
   not at plan-generation time.

2. **JS injection for element extraction, not Playwright locator APIs.** Playwright's APIs miss
   elements with programmatic event listeners. `page.evaluate()` with an injected listener tracker
   catches everything. See `docs/locator-strategy.md`.

3. **Steps are a set, not a strict sequence.** `StepScheduler` matches the current page state to
   the best pending step. This handles retailers with different checkout page orderings without
   plan modifications.

4. **Pluggable LLM.** `LLMClient` is an interface. `ClaudeClient` and `OllamaClient` implement it.
   The active client is configured via environment variable. Do not hardcode Claude anywhere outside
   `ClaudeClient.ts`.

5. **Observational validation is out of scope for v1.** Only structural and business logic
   validation classes are implemented.

6. **No Playwright test runner.** Pliant is a standalone Node.js program. It uses Playwright
   as a browser automation library, not as a test framework. There are no `.spec.ts` files for the
   main runner. Unit tests for the framework itself live in `tests/unit/`.

## Environment Variables

```
# LLM selection
LLM_PROVIDER=claude           # "claude" | "ollama"
ANTHROPIC_API_KEY=...         # required when LLM_PROVIDER=claude
OLLAMA_BASE_URL=...            # required when LLM_PROVIDER=ollama, e.g. http://localhost:11434
OLLAMA_MODEL=mistral           # model name for Ollama

# Execution
TARGET_URL=https://demowebshop.tricentis.com
HEADLESS=true                  # "true" | "false"
SLOW_MO=0                      # milliseconds between actions, useful for demo

# Report
REPORT_OUTPUT_DIR=./reports
```

## Running the Demo

```bash
# Install
npm install
npx playwright install chromium

# Run against the Tricentis demo shop
TARGET_URL=https://demowebshop.tricentis.com npm run demo

# Run against the nopCommerce demo
TARGET_URL=https://demo.nopcommerce.com npm run demo

# Generate comparison report (after both runs)
npm run report
```

## Rules Files

Read these before touching any code in their domain:

- `.claude/rules/typescript.md` — TypeScript conventions for this project
- `.claude/rules/architecture.md` — component boundaries and interaction rules
- `.claude/rules/llm-interface.md` — how to write prompts and parse responses
- `.claude/rules/testing.md` — how to test framework components
