import { createHash } from 'node:crypto'
import type { Message, TranscriptContext } from '@earendil-works/pi-ai'
import { NATIVE_REPLAY_DIAGNOSTIC } from '@earendil-works/pi-claude-code/src/transcript.ts'

// Anthropic rejects tool_use ids outside this pattern; other providers (Codex: `call_…|fc_…`) produce them.
const VALID = /^[a-zA-Z0-9_-]+$/

type Carrier = {
  message: { content: Array<{ type: string; id?: string }> }
  projection: { toolCalls: Array<{ id: string }> }
}

function carrierOf(message: Message) {
  if (message.role !== 'assistant') return undefined
  const index = message.diagnostics?.findIndex((item) => item.type === NATIVE_REPLAY_DIAGNOSTIC)
  if (index === undefined || index < 0) return undefined
  const carrier = message.diagnostics![index].details?.carrier as Partial<Carrier> | undefined
  if (!Array.isArray(carrier?.message?.content) || !Array.isArray(carrier.projection?.toolCalls))
    return undefined
  return { index, carrier: carrier as Carrier }
}

function idsOf(message: Message): string[] {
  if (message.role === 'toolResult') return [message.toolCallId]
  if (message.role !== 'assistant') return []
  const ids = message.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : []))
  const carrier = carrierOf(message)?.carrier
  if (carrier) {
    for (const block of carrier.message.content) if (block.type === 'tool_use') ids.push(block.id!)
    for (const call of carrier.projection.toolCalls) ids.push(call.id)
  }
  return ids
}

/**
 * Give every tool id Anthropic would reject a valid replacement for one Claude Code request. Valid ids stay as they
 * are; each invalid id gets a readable prefix and a hash of the original, rehashed on any collision, so distinct
 * originals stay distinct (also from valid ids) and the same transcript maps the same way on every replay.
 */
export function claudeToolIds(messages: Message[]): Map<string, string> {
  const ids = messages.flatMap(idsOf)
  const used = new Set(ids.filter((id) => VALID.test(id)))
  const map = new Map<string, string>()
  for (const id of ids) {
    if (used.has(id) || map.has(id)) continue
    const prefix = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    let candidate: string
    for (let attempt = 0; ; attempt++) {
      const hash = createHash('sha256').update(`${attempt}\0${id}`).digest('base64url').slice(0, 22)
      candidate = `${prefix}_${hash}`
      if (!used.has(candidate)) break
    }
    used.add(candidate)
    map.set(id, candidate)
  }
  return map
}

/**
 * The request context with tool ids made valid for Anthropic, as copies: the caller's messages are not changed.
 * Tool calls, their results and the native replay carrier (its tool_use blocks and projection) are mapped alike, so
 * upstream still recognises an unchanged carrier and replays its signed thinking.
 */
export function withClaudeToolIds(context: TranscriptContext): TranscriptContext {
  const map = claudeToolIds(context.messages)
  if (!map.size) return context
  const id = (value: string) => map.get(value) ?? value
  const messages = context.messages.map((message): Message => {
    if (message.role === 'toolResult')
      return map.has(message.toolCallId)
        ? { ...message, toolCallId: id(message.toolCallId) }
        : message
    if (message.role !== 'assistant' || !idsOf(message).some((value) => map.has(value)))
      return message
    const content = message.content.map((block) =>
      block.type === 'toolCall' ? { ...block, id: id(block.id) } : block,
    )
    const found = carrierOf(message)
    if (!found) return { ...message, content }
    const carrier = structuredClone(found.carrier)
    for (const block of carrier.message.content)
      if (block.type === 'tool_use') block.id = id(block.id!)
    for (const call of carrier.projection.toolCalls) call.id = id(call.id)
    const diagnostics = [...message.diagnostics!]
    const diagnostic = diagnostics[found.index]
    diagnostics[found.index] = {
      ...diagnostic,
      details: { ...diagnostic.details, carrier: carrier as never },
    }
    return { ...message, content, diagnostics }
  })
  return { ...context, messages }
}
