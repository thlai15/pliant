import { test, expect } from '@playwright/test'
import { createServer, IncomingMessage, Server } from 'http'
import { AddressInfo } from 'net'
import { ClaudeClient, ClaudeClientOptions, DEFAULT_CLAUDE_MODEL } from '@llm/ClaudeClient'

// ClaudeClient against a local fake Messages API: checks the request it sends and how
// it reads responses, without network access or an API key.

interface Captured {
  url: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

async function fakeApi(response: Record<string, unknown>): Promise<{ server: Server; baseURL: string; requests: Captured[] }> {
  const requests: Captured[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, baseURL: `http://127.0.0.1:${port}`, requests }
}

function message(content: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: DEFAULT_CLAUDE_MODEL,
    content, stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  }
}

const PROMPT = { system: 'Return a JSON object only.', user: 'Pick one', maxTokens: 256, temperature: 0, id: 'test' }

async function withClient(
  response: Record<string, unknown>,
  options: Partial<ClaudeClientOptions>,
  run: (client: ClaudeClient, requests: Captured[]) => Promise<void>,
): Promise<void> {
  const api = await fakeApi(response)
  try {
    const client = new ClaudeClient('test-key', { model: DEFAULT_CLAUDE_MODEL, effort: 'low', baseURL: api.baseURL, ...options })
    await run(client, api.requests)
  } finally {
    await new Promise<void>(resolve => api.server.close(() => resolve()))
  }
}

test('defaults to claude-opus-5-5', () => {
  expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5-5')
})

test('sends model and effort, no temperature, and a thinking-safe max_tokens', async () => {
  await withClient(message([{ type: 'text', text: '{"ok":true}' }]), {}, async (client, requests) => {
    await client.complete(PROMPT)
    const body = requests[0]?.body
    expect(body?.['model']).toBe('claude-opus-5-5')
    expect(body?.['output_config']).toEqual({ effort: 'low' })
    expect(body).not.toHaveProperty('temperature')
    expect(body?.['max_tokens']).toBeGreaterThanOrEqual(16000)
  })
})

test('opts into server-side refusal fallbacks on supported models', async () => {
  await withClient(message([{ type: 'text', text: '{}' }]), {}, async (client, requests) => {
    await client.complete(PROMPT)
    expect(requests[0]?.body['fallbacks']).toBe('default')
    expect(String(requests[0]?.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
  })
})

test('uses a custom model and leaves out effort and fallbacks when asked', async () => {
  await withClient(message([{ type: 'text', text: '{}' }]), { model: 'claude-haiku-4-5', effort: null }, async (client, requests) => {
    await client.complete(PROMPT)
    const body = requests[0]?.body
    expect(body?.['model']).toBe('claude-haiku-4-5')
    expect(body).not.toHaveProperty('output_config')
    expect(body).not.toHaveProperty('fallbacks')
  })
})

test('reads the answer after a leading thinking block', async () => {
  const response = message([
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"elementIndex":3}' },
  ])
  await withClient(response, {}, async client => {
    const result = await client.complete(PROMPT)
    expect(result.content).toBe('{"elementIndex":3}')
    expect(result.outputTokens).toBe(5)
  })
})

test('reports a refusal as an error', async () => {
  const response = message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } })
  await withClient(response, {}, async client => {
    await expect(client.complete(PROMPT)).rejects.toThrow(/declined.*cyber/)
  })
})
