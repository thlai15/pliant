import { LLMClient, LLMPrompt, LLMResponse } from '@llm/LLMClient'
import { LLMApiError } from '@types-local/errors'
import { createLogger } from '@types-local/logger'

const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_TEMPERATURE = 0
const RETRY_DELAY_MS = 2000
const MAX_ATTEMPTS = 2

const logger = createLogger('OllamaClient')

export class OllamaClient implements LLMClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

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
      `[${promptId}] Ollama request failed after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`,
      { cause: lastError }
    )
  }

  private async callOnce(
    prompt: LLMPrompt,
    maxTokens: number,
    temperature: number,
    promptId: string
  ): Promise<LLMResponse> {
    const url = `${this.baseUrl}/api/chat`
    const start = Date.now()
    logger.debug(`[${promptId}] system: ${prompt.system.slice(0, 400)}`)
    logger.debug(`[${promptId}] user: ${prompt.user.slice(0, 1500)}`)

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user',   content: prompt.user   },
        ],
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new LLMApiError(
        `[${promptId}] Ollama HTTP ${response.status}: ${response.statusText}${body ? ` — ${body}` : ''}`
      )
    }

    const data: unknown = await response.json()
    if (!isOllamaResponse(data)) {
      throw new LLMApiError(
        `[${promptId}] Unexpected Ollama response shape: ${JSON.stringify(data)}`
      )
    }

    const inputTokens = data.prompt_eval_count ?? 0
    const outputTokens = data.eval_count ?? 0
    logger.debug(`[${promptId}] response: ${data.message.content}`)
    logger.debug(
      `[${promptId}] in=${inputTokens} out=${outputTokens} ms=${Date.now() - start}`
    )

    return { content: data.message.content, inputTokens, outputTokens }
  }
}

interface OllamaMessage {
  role: string
  content: string
}

interface OllamaResponse {
  model: string
  message: OllamaMessage
  prompt_eval_count?: number
  eval_count?: number
}

function isOllamaResponse(value: unknown): value is OllamaResponse {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  const msg = obj['message']
  if (typeof msg !== 'object' || msg === null) return false
  return typeof (msg as Record<string, unknown>)['content'] === 'string'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
