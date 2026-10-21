import { LLMClient, LLMPrompt, LLMResponse } from '@llm/LLMClient'

// Returns a canned response for the first configured substring found in the
// prompt. Substrings are checked in the order they were added. A sequence answers
// successive matching calls in order and then repeats its last entry.
export class MockLLMClient implements LLMClient {
  private readonly responses = new Map<string, string[]>()
  readonly calls: LLMPrompt[] = []

  setResponse(promptSubstring: string, response: string): void {
    this.responses.set(promptSubstring, [response])
  }

  setResponseSequence(promptSubstring: string, responses: string[]): void {
    this.responses.set(promptSubstring, [...responses])
  }

  async complete(prompt: LLMPrompt): Promise<LLMResponse> {
    this.calls.push(prompt)
    for (const [key, queue] of this.responses) {
      if (prompt.user.includes(key) || prompt.system.includes(key)) {
        const value = queue.length > 1 ? queue.shift() : queue[0]
        if (value === undefined) break
        return { content: value, inputTokens: 0, outputTokens: 0 }
      }
    }
    throw new Error(`MockLLMClient: no response configured for prompt: ${prompt.user.slice(0, 100)}`)
  }
}
