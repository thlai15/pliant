export interface LLMPrompt {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
  // Prompt template identifier used for debug logging — set to the prompt filename
  id?: string
}

export interface LLMResponse {
  content: string
  inputTokens: number
  outputTokens: number
}

export interface LLMClient {
  complete(prompt: LLMPrompt): Promise<LLMResponse>
}
