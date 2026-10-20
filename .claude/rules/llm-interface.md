# LLM Interface Rules

## The LLMClient Interface

```typescript
interface LLMClient {
  complete(prompt: LLMPrompt): Promise<LLMResponse>
}

interface LLMPrompt {
  system: string
  user: string
  maxTokens?: number        // default: 1024
  temperature?: number      // default: 0 for matching/scoring, 0.3 for reasoning
}

interface LLMResponse {
  content: string
  inputTokens: number
  outputTokens: number
}
```

All LLM calls use this interface. The response is always a raw string — parsing is the caller's
responsibility.

## Prompt Files

Every distinct LLM call has its own file in `src/llm/prompts/`. The file exports a typed function
that takes the dynamic inputs and returns an `LLMPrompt`.

```
src/llm/prompts/
  matchElement.ts
  scoreSteps.ts
  evaluateAssertion.ts
  evaluateBusinessRule.ts
  extractFillValue.ts
```

Prompt functions are pure — no I/O, no side effects. They can be unit-tested with snapshot tests.

## Response Parsing

All LLM responses that return structured data must be JSON. The system prompt must instruct the
model to return JSON only, with no preamble or markdown fences.

```typescript
// In the system prompt:
"Return a JSON object only. No explanation, no markdown, no preamble."
```

Parse defensively:

```typescript
function parseMatchResult(raw: string): MatchResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new LLMParseError(`LLM returned non-JSON for element match: ${raw}`)
  }

  if (!isMatchResult(parsed)) {
    throw new LLMParseError(`LLM response did not match MatchResult schema: ${raw}`)
  }

  return parsed
}
```

Write a type guard (`isMatchResult`) for every expected response shape.

## Prompt Design Principles

### Be explicit about output format

Every prompt ends with an explicit JSON schema example showing the exact shape expected:

```
Return this exact JSON structure:
{
  "elementIndex": <integer>,
  "confidence": <float 0.0-1.0>,
  "reasoning": "<one sentence string>",
  "fillValue": "<string or null>",
  "alternativeIndices": [<integer>, ...]
}
```

### Separate system and user content

- System prompt: role, rules, output format specification
- User prompt: the dynamic content (candidates, step intent, page state)

Never put the output format spec in the user prompt — it belongs in the system prompt.

### Keep candidate lists concise

The element extractor may return 100+ candidates. Send a filtered, formatted list — not raw
`ExtractedElement` objects. The prompt formatter should:

1. Filter to elements whose region is plausible for the step type
2. Deduplicate elements with identical path and label
3. Format each as a pipe-delimited line: `index | path | label | tag | events | region`
4. Cap at 50 candidates maximum

If filtering reduces the list below 5, remove the filter and send up to 50 from the full list.

### Temperature

- Element matching and step scoring: `temperature: 0` — deterministic, no creativity needed
- Assertion evaluation: `temperature: 0` — pass/fail should be consistent
- Reasoning/explanation fields: these are part of the same call, temperature stays at 0

Never use temperature > 0 in Pliant v1. Consistency matters more than variety.

### Token budget

| Prompt type | Typical input tokens | Max output tokens |
|---|---|---|
| Element matching | 800–1500 | 256 |
| Step scoring | 400–800 | 512 |
| Assertion evaluation | 500–1000 | 256 |
| Business rule evaluation | 300–600 | 256 |

Set `maxTokens` conservatively. A response that exceeds the budget and gets cut off is worse than
a slightly tighter prompt.

## Retry Policy

`LLMClient` implementations handle retries internally. The interface caller does not retry.
Default policy: 2 attempts with 2s delay on API error. On parse error (malformed JSON), do not
retry — fix the prompt instead.

## Logging

Every LLM call is logged at DEBUG level with:
- Prompt identifier (filename of the prompt template)
- Input token count
- Output token count
- Duration in ms

This is essential for diagnosing token cost and latency in the demo.

## Ollama Compatibility

Prompts must work with both Claude Sonnet and smaller models (Mistral, Qwen via Ollama). Write
prompts that do not rely on extended context or chain-of-thought — smaller models need clearer,
more constrained instructions.

Test each new prompt against Mistral 7B via Ollama before considering it production-ready.
If a prompt only works with Claude, document why and flag it clearly.
