import { expect, it } from 'vitest'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { prepareFrames } from '@earendil-works/pi-claude-code/src/transcript.ts'
import { claudeToolIds, withClaudeToolIds } from '../extensions/claude-code/tool-ids.ts'

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const call = (...ids: string[]): AssistantMessage => ({
  role: 'assistant',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  model: 'gpt-5.5',
  usage,
  stopReason: 'toolUse',
  timestamp: 0,
  content: ids.map((id) => ({ type: 'toolCall', id, name: 'read', arguments: {} })),
})
const result = (toolCallId: string): Message => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  timestamp: 0,
})

it('keeps valid ids and maps invalid ones to distinct valid ids, also when they sanitize alike', () => {
  const long = 'call_abc|fc_' + 'x'.repeat(200)
  const messages = [
    call('a|b', 'a.b', 'a_b', long),
    result('a|b'),
    result('a.b'),
    result('a_b'),
    result(long),
  ]
  const map = claudeToolIds(messages)
  expect([...map.keys()]).toEqual(['a|b', 'a.b', long])
  const mapped = [...map.values()]
  expect(new Set([...mapped, 'a_b']).size).toBe(4)
  for (const id of mapped) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  // Deterministic: the same transcript maps the same way.
  expect(claudeToolIds(structuredClone(messages))).toEqual(map)
})

it('moves an invalid id off a valid id that equals its generated replacement', () => {
  const generated = claudeToolIds([call('x|y')]).get('x|y')!
  const map = claudeToolIds([call('x|y'), result('x|y'), call(generated), result(generated)])
  expect(map.has(generated)).toBe(false)
  expect(map.get('x|y')).not.toBe(generated)
  expect(map.get('x|y')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
})

it('maps the native replay carrier with its message, without changing the input', () => {
  const assistant: AssistantMessage = {
    ...call('n|1'),
    content: [
      { type: 'thinking', thinking: 'Plan.', thinkingSignature: 'sig' },
      { type: 'toolCall', id: 'n|1', name: 'read', arguments: {} },
    ],
    diagnostics: [
      {
        type: 'claude-code.native-assistant.v1',
        timestamp: 0,
        details: {
          carrier: {
            version: 1,
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'Plan.', signature: 'native-sig' },
                { type: 'tool_use', id: 'n|1', name: 'mcp__pi__read', input: {} },
              ],
            },
            projection: { text: '', toolCalls: [{ id: 'n|1', name: 'read', input: {} }] },
          },
        },
      },
    ],
  }
  const context = normalizeContext({
    messages: [{ role: 'user', content: 'Go.', timestamp: 0 }, assistant, result('n|1')],
  })
  const before = structuredClone(context)
  const frames = prepareFrames(withClaudeToolIds(context).messages)
  expect(context).toEqual(before)
  const id = claudeToolIds(context.messages).get('n|1')
  // The carrier still matches its projection, so the native signed block is replayed.
  expect(frames[1]?.message.content).toEqual([
    { type: 'thinking', thinking: 'Plan.', signature: 'native-sig' },
    { type: 'tool_use', id, name: 'mcp__pi__read', input: {} },
  ])
  expect(frames[2]?.message.content).toMatchObject([{ type: 'tool_result', tool_use_id: id }])
})

it('returns the context itself when every id is valid', () => {
  const longValid = 'toolu_' + 'x'.repeat(100)
  const context = normalizeContext({
    messages: [call('toolu_1', longValid), result('toolu_1'), result(longValid)],
  })
  expect(withClaudeToolIds(context)).toBe(context)
})
