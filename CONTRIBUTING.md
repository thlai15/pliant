# Contributing to Pliant

Thanks for your interest. Bug reports, plans for new kinds of apps, and fixes are all welcome.

## Reporting bugs and ideas

Open an issue with what you ran, what you expected, and what happened. For a failed run, the
most useful attachments are the step from `reports/<run-id>/run.json` and the matching
screenshot. Report security issues privately instead (see [SECURITY.md](SECURITY.md)).

## Development setup

Requirements: Node.js 22+.

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env
```

The unit tests need no LLM and no network. To run the demo against a live site you also need
an LLM backend: [Ollama](https://ollama.com) with `ollama pull mistral`, or an Anthropic API
key with `LLM_PROVIDER=claude`.

## Checks

These are the checks CI runs on every pull request. Run them before you push:

```bash
npm run typecheck
npm run lint
npm test
```

If you change matching, scheduling or the execution loop, also run the demo
(`npm run demo`) and include the before and after step results in the pull request.

## Design rules

The full rules are in [.claude/rules/](.claude/rules/). The ones reviewers check most:

- **No app knowledge in `src/`.** Anything specific to a site or an industry belongs in the
  plan, not in code. Pre-filters may key on the kind of action ("enter", "click", "dismiss
  dialog"), never on domain words such as "cart" or "checkout".
- **Browser access goes through `BrowserDriver`.** Only `src/driver/PlaywrightDriver.ts`
  imports Playwright. A test fails if anything else does.
- **LLM access goes through `LLMClient`.** Prompts live in `src/llm/prompts/`, one file per
  prompt, as pure functions.
- **Runs never modify the plan file.** Learned element hints go to
  `reports/<run-id>/enriched-plan.md`.
- **No `any` and no `!` non-null assertions.** Treat external data as `unknown` and narrow it
  with a type guard.

## Adding a browser driver

Implement `BrowserDriver` in `src/driver/<Name>Driver.ts`, register it in `createDriver()` in
`src/runner/PlanRunner.ts`, and copy `tests/unit/driver/PlaywrightDriver.test.ts` for the new
driver. [docs/architecture.md](docs/architecture.md) covers the details.

## Test data

Plans and fixtures must use fictional data only: `example.com` email addresses, `555-01xx`
phone numbers and made-up names and addresses. Never commit real personal details, session
cookies or API keys.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one change, with tests for new behaviour.
3. Open the pull request against `main`. It merges once CI passes, and is squashed into a
   single commit.

By contributing you agree that your work is released under the [MIT License](LICENSE).
