import { LLMClient } from '@llm/LLMClient'
import { evaluateAssertionPrompt } from '@llm/prompts/evaluateAssertion'
import { AssertionReport, ExtractedElement } from '@types-local/index'
import { createLogger } from '@types-local/logger'

const logger = createLogger('AssertionEvaluator')

export class AssertionEvaluator {
  constructor(private readonly llm: LLMClient) {}

  // Evaluates every expect string against the provided page element list.
  // Expects are evaluated independently; all results are returned.
  async evaluate(
    expects: string[],
    candidates: ExtractedElement[],
    pageUrl?: string,
    productDialogOpen?: boolean,
    pageText?: string,
  ): Promise<AssertionReport[]> {
    if (expects.length === 0) return []

    // Evaluate in parallel — each expect is independent.
    return Promise.all(expects.map(e => this.evaluateOne(e, candidates, pageUrl, productDialogOpen, pageText)))
  }

  private async evaluateOne(
    expectText: string,
    candidates: ExtractedElement[],
    pageUrl?: string,
    productDialogOpen?: boolean,
    pageText?: string,
  ): Promise<AssertionReport> {
    const prompt = evaluateAssertionPrompt(expectText, candidates, pageUrl, productDialogOpen, pageText)
    const response = await this.llm.complete(prompt)

    const result = parseAssertionResponse(response.content)
    logger.debug(`assert "${expectText.slice(0, 60)}" → ${result.pass ? 'PASS' : 'FAIL'}`)

    return { expect: expectText, pass: result.pass, reasoning: result.reasoning }
  }
}

interface RawAssertionResult {
  pass: boolean
  reasoning: string
}

function parseAssertionResponse(raw: string): RawAssertionResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    // Mistral sometimes omits the closing `}` when the reasoning string consumes most of
    // the token budget. Extract the pass field directly before giving up.
    const m = raw.match(/"pass"\s*:\s*(true|false)/)
    const passValue = m?.[1]
    if (passValue !== undefined) {
      return { pass: passValue === 'true', reasoning: 'Extracted from partial JSON response' }
    }
    return { pass: false, reasoning: `LLM returned non-JSON: ${raw.slice(0, 120)}` }
  }
  if (!isAssertionResult(parsed)) {
    return { pass: false, reasoning: `Unexpected response shape: ${raw.slice(0, 120)}` }
  }
  return parsed
}

function isAssertionResult(v: unknown): v is RawAssertionResult {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['pass'] === 'boolean' && typeof o['reasoning'] === 'string'
}
