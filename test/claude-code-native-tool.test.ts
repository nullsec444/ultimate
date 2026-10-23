import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { normalizeError, piToolName } from '@earendil-works/pi-claude-code/src/stream.ts'
import { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/stream.ts — a tool_use the request did not offer (a bare
// `bash` instead of `mcp__pi__bash`) failed the turn with a non-retryable error. Drop with the matching pnpm patch
// when upstream retries it.
const tools = new Set(['bash', 'read'])

const sse = (events: object[]) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('')

// The response that failed #314224's first call: signed thinking, then a tool named without the MCP prefix.
const bareBash = sse([
  {
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 2 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} },
  },
])

it('maps prefixed tools to Pi names and rejects names outside the request', () => {
  expect(piToolName('mcp__pi__bash', tools)).toBe('bash')
  expect(() => piToolName('bash', tools)).toThrow('unexpected tool bash')
  expect(() => piToolName('mcp__pi__restart', tools)).toThrow('unavailable tool restart')
})

it('retries a turn whose model names a tool the request did not offer', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(bareBash)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn((event) => {
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      piToolName(event.content_block.name, tools)
    }
  })
  try {
    await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })
      .then((response) => response.text())
      .catch(() => 'the relay drops the connection once it fails mid-stream')
    await relay.settled()
    expect(relay.status).toBe(200)
    expect(relay.capture.complete).toBe(false)
    expect(relay.failure).toMatch(/^Error: Claude Code returned unexpected tool bash/)
    // The message claude-cli.ts builds from this relay state.
    const message = {
      stopReason: 'error',
      errorMessage: normalizeError(
        new Error(
          `Incomplete Claude Code upstream response (status 200, capture incomplete, relay failure ${relay.failure})`,
        ),
      ),
    } as AssistantMessage
    expect(isRetryableAssistantError(message)).toBe(true)
  } finally {
    await relay.close()
    upstream.close()
  }
})
