import { LLMClient } from '@llm/LLMClient'
import { ExtractedElement, MatchResult, SelectorCache, ElementHint } from '@types-local/index'
import { matchElementPrompt } from '@llm/prompts/matchElement'
import { LLMParseError } from '@types-local/errors'
import { createLogger } from '@types-local/logger'

const logger = createLogger('SemanticMatcher')

export class SemanticMatcher {
  private readonly cache: SelectorCache = new Map()

  constructor(private readonly llm: LLMClient) {}

  // Matches the step intent against the candidate elements using the LLM.
  // stepId is used for within-run selector caching to avoid redundant calls.
  // elementHint, when provided, is included in the prompt as prior evidence from
  // a previous run — it biases the scoring toward the historically-matched element.
  async match(
    intent: string,
    candidates: ExtractedElement[],
    stepId: string | null = null,
    elementHint: ElementHint | null = null,
  ): Promise<MatchResult> {
    if (stepId !== null) {
      const cachedSelector = this.cache.get(stepId)
      if (cachedSelector !== undefined) {
        const hit = candidates.find(c => c.selector === cachedSelector)
        if (hit !== undefined) {
          logger.debug(`[${stepId}] cache hit selector=${cachedSelector}`)
          return {
            elementIndex: hit.index,
            confidence: 1.0,
            reasoning: 'Matched via within-run selector cache',
            fillValue: null,
            alternativeIndices: [],
          }
        }
      }
    }

    const { prompt, displayMap } = matchElementPrompt(intent, candidates, elementHint)
    const response = await this.llm.complete(prompt)
    logger.debug(`Match raw response: ${response.content}`)
    const rawResult = parseMatchResult(response.content)

    // The prompt shows the filtered candidate set (displayMap). Mistral 7B sometimes
    // returns a low integer (e.g. 0) that it intends as "the first/hint-matched element"
    // rather than a specific DOM extraction index. Guard against this by looking the
    // returned index up in displayMap first. Only if it is not found there (or has no
    // selector) do we try the position fallback — treating the returned value as a
    // 0-based slot in the display list rather than an actual DOM index.
    let result: MatchResult = rawResult
    if (rawResult.elementIndex !== -1) {
      const byIndex = displayMap.find(c => c.index === rawResult.elementIndex)
      const selectorInvalid = byIndex === undefined || !byIndex.selector || byIndex.selector.trim() === ''
      if (selectorInvalid) {
        const byPosition = displayMap[rawResult.elementIndex]
        if (byPosition !== undefined && byPosition.selector && byPosition.selector.trim() !== '') {
          logger.debug(
            `Index-to-position fallback: LLM returned ${rawResult.elementIndex} ` +
            `not in display set — using display-position element #${byPosition.index}`
          )
          result = { ...rawResult, elementIndex: byPosition.index }
        } else if (displayMap.length === 1 && displayMap[0] !== undefined) {
          // When exactly one candidate was shown (e.g. after secondary keyword
          // narrowing), the LLM has no real choice — any returned index outside the
          // display set must mean that one candidate.
          logger.debug(
            `Single-candidate fallback: LLM returned ${rawResult.elementIndex} ` +
            `but only one candidate was shown — using element #${displayMap[0].index}`
          )
          result = { ...rawResult, elementIndex: displayMap[0].index }
        } else {
          // Truncation fallback: Mistral sometimes shortens a high extraction index
          // (e.g. returns 9 when the correct index is 10009). Try to recover by
          // finding all candidates whose index ends with the returned digits, then
          // taking the one with the lowest extraction index (earliest in DOM order).
          const xStr = String(rawResult.elementIndex)
          const truncCandidates = displayMap.filter(
            c => String(c.index).endsWith(xStr) && c.selector && c.selector.trim() !== ''
          )
          if (truncCandidates.length > 0) {
            const best = truncCandidates.reduce((a, b) => a.index < b.index ? a : b)
            logger.debug(`Truncation fallback: LLM returned ${rawResult.elementIndex} → element #${best.index}`)
            result = { ...rawResult, elementIndex: best.index }
          }
        }
      }
    }

    if (stepId !== null) {
      const matched = candidates.find(c => c.index === result.elementIndex)
      if (matched !== undefined) {
        this.cache.set(stepId, matched.selector)
      }
    }

    logger.debug(
      `match intent="${intent.slice(0, 60)}" ` +
      `elementIndex=${result.elementIndex} confidence=${result.confidence}`
    )

    return result
  }
}

function parseMatchResult(raw: string): MatchResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch (error) {
    throw new LLMParseError(`LLM returned non-JSON for element match: ${raw}`, { cause: error })
  }

  if (!isMatchResultRaw(parsed)) {
    throw new LLMParseError(`LLM response did not match MatchResult schema: ${raw}`)
  }

  const o = parsed as Record<string, unknown>
  // When the LLM cannot find a match it returns elementIndex: null.
  // Preserve fillValue (the LLM often knows what to type even when it can't
  // identify the target element) and signal no-match via sentinel index -1
  // with confidence 0 so the caller can apply fallback logic.
  const elementIndex = o['elementIndex'] === null ? -1 : (o['elementIndex'] as number)
  const confidence   = o['elementIndex'] === null ? 0   : (o['confidence'] as number)
  return {
    elementIndex,
    confidence,
    reasoning:          o['reasoning'] as string,
    fillValue:          o['fillValue'] as string | null,
    alternativeIndices: Array.isArray(o['alternativeIndices']) ? o['alternativeIndices'] as number[] : [],
  }
}

function isMatchResultRaw(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    (typeof o['elementIndex'] === 'number' || o['elementIndex'] === null) &&
    typeof o['confidence']         === 'number' &&
    typeof o['reasoning']          === 'string' &&
    (o['fillValue'] === null || typeof o['fillValue'] === 'string') &&
    (o['alternativeIndices'] === undefined || Array.isArray(o['alternativeIndices']))
  )
}
