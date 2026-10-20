import { LLMClient, LLMPrompt, LLMResponse } from '@llm/LLMClient'

// Returns a canned response for the first configured substring found in the
// prompt. Substrings are checked in the order they were added.
export class MockLLMClient implements LLMClient {
  private readonly responses = new Map<string, string>()

  setResponse(promptSubstring: string, response: string): void {
    this.responses.set(promptSubstring, response)
  }

  async complete(prompt: LLMPrompt): Promise<LLMResponse> {
    for (const [key, value] of this.responses) {
      if (prompt.user.includes(key) || prompt.system.includes(key)) {
        return { content: value, inputTokens: 0, outputTokens: 0 }
      }
    }
    throw new Error(`MockLLMClient: no response configured for prompt: ${prompt.user.slice(0, 100)}`)
  }
}
