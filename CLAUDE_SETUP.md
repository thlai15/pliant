# Pliant — Project Setup Prompt

Use this prompt when initialising Pliant in a new environment with Claude Code.

---

## Prompt

You are setting up the Pliant project — a plan-driven, self-healing test execution framework
built with Node.js, TypeScript, and Playwright. Read CLAUDE.md first, then complete the following
setup tasks in order.

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Verify tsconfig.json

The root `tsconfig.json` is for editor tooling and type checking only — Playwright handles its own
transpilation internally. Confirm it contains:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "outDir": "dist",
    "baseUrl": ".",
    "paths": {
      "@runner/*": ["src/runner/*"],
      "@locator/*": ["src/locator/*"],
      "@llm/*": ["src/llm/*"],
      "@parser/*": ["src/parser/*"],
      "@report/*": ["src/report/*"],
      "@types-local/*": ["src/types/*"]
    }
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "playwright.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Note: Playwright only uses `allowJs`, `baseUrl`, `paths`, and `references` from tsconfig. The rest
of these options only affect `tsc` type checking. Always run `npx tsc --noEmit` alongside
execution to catch type errors.

### 3. Verify playwright.config.ts

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Pliant does not use Playwright's test runner for the main framework.
  // This config exists for unit tests in tests/unit/ only.
  testDir: './tests/unit',
  timeout: 30_000,
  use: {
    headless: process.env.HEADLESS !== 'false',
    slowMo: Number(process.env.SLOW_MO ?? 0),
    screenshot: 'only-on-failure',
    video: 'off',
  },
  reporter: [['list'], ['html', { outputFolder: 'reports/unit', open: 'never' }]],
});
```

### 4. Verify package.json scripts

```json
{
  "scripts": {
    "demo": "ts-node src/runner/PlanRunner.ts",
    "report": "ts-node src/report/HtmlReporter.ts",
    "typecheck": "tsc --noEmit",
    "test": "playwright test",
    "lint": "eslint src tests --ext .ts"
  }
}
```

### 5. Create .env.example

```
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral
TARGET_URL=https://demowebshop.tricentis.com
HEADLESS=true
SLOW_MO=0
REPORT_OUTPUT_DIR=./reports
```

### 6. Confirm directory structure

Run `find src -type d` and verify the following directories exist:

```
src/runner
src/locator
src/llm
src/llm/prompts
src/parser
src/report
src/types
```

Create any missing directories with a `.gitkeep` placeholder.

### 7. Run type check

```bash
npx tsc --noEmit
```

There should be zero errors before any implementation begins. If there are errors, fix them before
proceeding.

### 8. Confirm you have read the rules files

Before writing any implementation code, confirm you have read:

- `.claude/rules/typescript.md`
- `.claude/rules/architecture.md`
- `.claude/rules/llm-interface.md`
- `.claude/rules/testing.md`

---

Once setup is verified, begin implementation by reading `docs/architecture.md` for the full system
design, then `docs/execution-loop.md` for the step-by-step execution flow.
