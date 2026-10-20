import Anthropic from '@anthropic-ai/sdk'
import { LLMClient, LLMPrompt, LLMResponse } from '@llm/LLMClient'
import { LLMApiError } from '@types-local/errors'
import { createLogger } from '@types-local/logger'

const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_TEMPERATURE = 0
const RETRY_DELAY_MS = 2000
const MAX_ATTEMPTS = 2

const logger = createLogger('ClaudeClient')

export class ClaudeClient implements LLMClient {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async complete(prompt: LLMPrompt): Promise<LLMResponse> {
    const maxTokens = prompt.maxTokens ?? DEFAULT_MAX_TOKENS
    const temperature = prompt.temperature ?? DEFAULT_TEMPERATURE
    const promptId = prompt.id ?? 'unknown'

    let lastError: unknown = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.callOnce(prompt, maxTokens, temperature, promptId)
      } catch (error) {
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

  private async callOnce(
    prompt: LLMPrompt,
    maxTokens: number,
    temperature: number,
    promptId: string
  ): Promise<LLMResponse> {
    const start = Date.now()
    logger.debug(`[${promptId}] system: ${prompt.system.slice(0, 400)}`)
    logger.debug(`[${promptId}] user: ${prompt.user.slice(0, 1500)}`)

    const message = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      temperature,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    })

    const block = message.content[0]
    if (block === undefined || block.type !== 'text') {
      throw new LLMApiError(`[${promptId}] Claude response contained no text block`)
    }

    const inputTokens = message.usage.input_tokens ?? 0
    const outputTokens = message.usage.output_tokens
    logger.debug(`[${promptId}] response: ${block.text}`)
    logger.debug(
      `[${promptId}] in=${inputTokens} out=${outputTokens} ms=${Date.now() - start}`
    )

    return { content: block.text, inputTokens, outputTokens }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
