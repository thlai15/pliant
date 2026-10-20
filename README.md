# Pliant

Pliant is a plan-driven, self-healing test runner. You write a test plan in Markdown, using the
Playwright Planner format, and Pliant runs it directly against a live web app. It does not generate a test script first. At each step an LLM picks the
page element that best matches the step's intent, so the same plan keeps working when labels,
layouts or page order differ between sites.

## How it works

1. `PlanParser` reads the plan into scenarios, steps, `expect` assertions and optional `rules`
   blocks (formulas checked against values read from the page).
2. `StepScheduler` picks the pending step that best fits the current page, so steps can run out of
   order when a site's flow differs from the plan.
3. `ElementExtractor` injects JavaScript into the page to list interactive elements with their
   labels, containers and event listeners.
4. `SemanticMatcher` asks the LLM which element matches the step, and Playwright performs the action.
5. `ReportBuilder` and `HtmlReporter` record every step, screenshot and healing event and produce an
   HTML report.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Requirements

- Node.js 22+
- One LLM backend:
  - [Ollama](https://ollama.com) running locally (default), e.g. `ollama pull mistral`
  - or an Anthropic API key

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env    # then edit .env
npm run demo
```

`npm run demo` runs [plans/shopping-cart.md](plans/shopping-cart.md) against `TARGET_URL`.
Run it once per site, then build a side-by-side comparison of the two runs:

```bash
npm run report -- --run-a reports/<run-id-1> --run-b reports/<run-id-2>
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TARGET_URL` | (required) | Site to test |
| `PLAN_FILE` | `plans/shopping-cart.md` | Plan to execute |
| `LLM_PROVIDER` | `ollama` | `ollama` or `claude` |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `mistral` | Ollama model name |
| `ANTHROPIC_API_KEY` | | Required when `LLM_PROVIDER=claude` |
| `HEADLESS` | `true` | Show the browser with `false` |
| `SLOW_MO` | `0` | Delay between Playwright actions (ms) |
| `REPORT_OUTPUT_DIR` | `./reports` | Where run data and reports are written |

## Writing a plan

A plan is Markdown with numbered steps. Each step can carry `expect:` assertions, `after:`
dependencies, `stop: true`, and a fenced `rules` block for business-rule checks. The format is
documented in [docs/plan-format.md](docs/plan-format.md). The included shopping-cart plan is an
example; plans for other kinds of apps need no code changes.

## Development

```bash
npm run typecheck
npm test            # unit tests (Playwright test runner, local HTML fixtures only)
npm run lint
```

`CLAUDE.md` and `.claude/` hold the project rules and hooks used when developing with Claude Code.

## Responsible use

Only run Pliant against sites you own or have permission to test. The bundled plan targets public
demo stores and stops before an order is placed. All contact and address data in the plans is
fictional.

## License

[MIT](LICENSE)
