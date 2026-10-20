# TypeScript Rules

## Compiler Settings

Strict mode is non-negotiable. The tsconfig has `strict: true`, `noUncheckedIndexedAccess: true`,
`noImplicitReturns: true`, and `exactOptionalPropertyTypes: true`. Never disable these per-file
with `@ts-ignore` or `@ts-nocheck`. If a type error is genuinely wrong, fix the type, not the
check.

## No `any`

Never use `any`. If you are receiving an unknown value (LLM response, `page.evaluate()` return,
JSON parse), type it as `unknown` and narrow it explicitly.

```typescript
// Wrong
const result: any = await page.evaluate(script)

// Right
const result: unknown = await page.evaluate(script)
if (!isExtractedElementArray(result)) {
  throw new Error(`Unexpected extraction result shape: ${JSON.stringify(result)}`)
}
```

Write type guards (`isX(value): value is X`) for all external data boundaries.

## Error Handling

Never swallow errors silently. Every `catch` block must either:
- Re-throw (possibly wrapping with context)
- Log and return a typed failure result

```typescript
// Wrong
try {
  await doSomething()
} catch {
  // ignore
}

// Right
try {
  await doSomething()
} catch (error) {
  throw new PliantError('Failed to extract elements', { cause: error })
}
```

Define typed error classes in `src/types/errors.ts`. Use `cause` chaining to preserve the
original error.

## Async

All I/O is async. Never use synchronous file I/O (`fs.readFileSync`) in the execution path.
Use `fs/promises` throughout.

Never use `Promise.all` with side-effectful operations that must be sequential. Use `for...of`
with `await` instead.

## Imports

Use path aliases defined in tsconfig. Never use relative `../../../` chains beyond one level.

```typescript
// Wrong
import { SemanticMatcher } from '../../../locator/SemanticMatcher'

// Right
import { SemanticMatcher } from '@locator/SemanticMatcher'
```

## Types vs Interfaces

Use `interface` for object shapes that may be extended (domain objects, LLM client interface).
Use `type` for unions, intersections, and aliases.

```typescript
interface ExtractedElement { ... }     // extensible shape
type StepOutcome = 'PASS' | 'FAIL'    // union
type MatchResult = { ... }             // simple alias is fine with type
```

## Null Handling

Prefer `null` over `undefined` for intentionally absent values. Use `undefined` only where
TypeScript infers it naturally (optional fields, array access with `noUncheckedIndexedAccess`).

Use optional chaining (`?.`) and nullish coalescing (`??`) freely. Do not use `!` non-null
assertions — if you are certain a value is non-null, prove it with a guard.

```typescript
// Wrong
const label = element.label!

// Right
const label = element.label ?? element.text
```

## Constants

Confidence thresholds and other magic numbers must be named constants in `src/types/constants.ts`.
Never write `0.75` or `0.40` inline in execution code.

```typescript
export const CONFIDENCE_THRESHOLD = 0.75
export const MIN_CONFIDENCE = 0.40
export const SCHEDULER_MIN_SCORE = 0.50
export const MAX_CONSECUTIVE_ADVANCES = 3
export const ELEMENT_SCREENSHOT_PADDING = 20
```

## Dependency Injection

LLM clients, page objects, and report builders are never instantiated inside components. They are
constructed once at the top level (`PlanRunner`) and passed as constructor parameters. This makes
components testable without live dependencies.

```typescript
// Wrong — inside a component
class SemanticMatcher {
  private llm = new ClaudeClient()   // hard dependency
}

// Right
class SemanticMatcher {
  constructor(private readonly llm: LLMClient) {}
}
```

## Logging

Use a thin logger wrapper (`src/types/logger.ts`) rather than `console.log` directly. The logger
respects a `LOG_LEVEL` env var and prefixes output with component name and timestamp. This makes
log output useful in CI and suppressible in tests.

## File Length

If a file exceeds 300 lines, consider whether it has grown beyond a single responsibility. Split
before it becomes a problem, not after.
