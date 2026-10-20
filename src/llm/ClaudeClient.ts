import Anthropic from '@anthropic-ai/sdk'
import { LLMClient, LLMPrompt, LLMResponse } from '@llm/LLMClient'
import { LLMApiError, LLMRefusalError } from '@types-local/errors'
import { createLogger } from '@types-local/logger'

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'low'

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ClaudeClientOptions {
  model: string
  // null omits output_config.effort, for models that do not accept it (e.g. Haiku 4.5)
  effort: ClaudeEffort | null
  // Overrides the API endpoint (tests point this at a local fake server)
  baseURL?: string
}

// Thinking tokens count toward max_tokens on current models, so the small per-prompt
// budgets in src/llm/prompts (sized for the JSON answer alone) are raised to this floor.
const MIN_MAX_TOKENS = 16000
const RETRY_DELAY_MS = 2000
const MAX_ATTEMPTS = 2

// Models that accept server-side refusal fallbacks (fallbacks: "default").
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

const logger = createLogger('ClaudeClient')

// Current Claude models reject sampling parameters, so LLMPrompt.temperature is not sent;
// output_config.effort is the knob instead (low suits Pliant's short JSON answers).
export class ClaudeClient implements LLMClient {
  private readonly client: Anthropic

  constructor(apiKey: string, private readonly options: ClaudeClientOptions) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: 0, // complete() retries itself
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    })
  }

  async complete(prompt: LLMPrompt): Promise<LLMResponse> {
    const maxTokens = Math.max(prompt.maxTokens ?? 0, MIN_MAX_TOKENS)
    const promptId = prompt.id ?? 'unknown'

    let lastError: unknown = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.callOnce(prompt, maxTokens, promptId)
      } catch (error) {
        if (error instanceof LLMRefusalError) throw error
        lastError = error
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(`[${promptId}] attempt ${attempt} failed: ${String(error)}, retrying in ${RETRY_DELAY_MS}ms`)
          await sleep(RETRY_DELAY_MS)
        }
      }
    }
    throw new LLMApiError(
      `[${promptId}] Claude API failed after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`,
      { cause: lastError }
    )
  }

  private async callOnce(prompt: LLMPrompt, maxTokens: number, promptId: string): Promise<LLMResponse> {
    const start = Date.now()
    const { model, effort } = this.options
    logger.debug(`[${promptId}] model=${model} effort=${effort ?? 'default'}`)
    logger.debug(`[${promptId}] system: ${prompt.system.slice(0, 400)}`)
    logger.debug(`[${promptId}] user: ${prompt.user.slice(0, 1500)}`)

    const useFallbacks = FALLBACK_MODELS.has(model)
    const message = await this.client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      ...(effort !== null ? { output_config: { effort } } : {}),
      ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    })

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unspecified'
      throw new LLMRefusalError(`[${promptId}] Claude declined the request (category: ${category})`)
    }

    // Thinking blocks precede the answer, so look for the text block rather than content[0].
    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text === '') {
      throw new LLMApiError(`[${promptId}] Claude response contained no text (stop_reason: ${message.stop_reason})`)
    }

    const inputTokens = message.usage.input_tokens
    const outputTokens = message.usage.output_tokens
    logger.debug(`[${promptId}] response: ${text}`)
    logger.debug(`[${promptId}] served-by=${message.model} in=${inputTokens} out=${outputTokens} ms=${Date.now() - start}`)

    return { content: text, inputTokens, outputTokens }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
