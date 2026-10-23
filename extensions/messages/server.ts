import { randomUUID } from 'node:crypto'
import type { Context, JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  configure,
  InboxDoc,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  GenerationResult,
  SubmissionId,
  TaskId,
  TaskRuntime,
  Tx,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Handoff, WorkspacesApi } from '../workspaces/api.ts'
import { isolatable } from '../../lib/git.ts'

import { Standing, Subagents, SubagentsApi } from '../subagents/api.ts'
import { locate, postAction, selfAddress } from '../../lib/remote.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { parseDecisions } from '../../lib/decisions.ts'
import { LineageApi, Roots } from '../lineage/api.ts'
import { ConversationsApi } from '../conversations/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import type { SummaryModel } from '../conversations/summary-model.ts'
import { Asked, Messages, MessagesApi, Gate, MessageSent, Triaged } from './api.ts'
import type { Message } from './api.ts'
import { callerOf } from './caller.ts'
import { CallerAction } from './refs.ts'
import type { Remote, Triage } from './refs.ts'
import { implementAction } from '../../lib/actions.ts'
import { actingAs } from '../../lib/acting-as.ts'
import { declared, needsDecision, parseVerdict, TRIAGE_SYSTEM, triageInput } from './triage.ts'
import type { Verdict } from './triage.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'
import { UserInputEvent } from '../../shared/events.ts'
import type { Device } from '../../shared/events.ts'
export const docs = [Messages]

/**
 * Which images to forward: `latest`, the newest entry in the sender's conversation with images (a pasted input or a
 * tool result such as a screenshot), or that entry's id.
 */
export type ImagesRef = 'latest' | number
const SCAN_PAGE = 200
function imagesOf(entry: EntryRecord | undefined) {
  return (entry?.model ?? []).flatMap((message) =>
    (message.role === 'user' || message.role === 'toolResult') &&
    typeof message.content !== 'string'
      ? message.content.flatMap((block) =>
          block.type === 'image'
            ? [{ type: 'image' as const, data: block.data, mimeType: block.mimeType }]
            : [],
        )
      : [],
  )
}
/** Resolve `ref` against conversation `from`'s visible history to the entry holding the images, checking the limits. */
async function resolveImages(tx: Tx, from: ConversationId, ref: ImagesRef) {
  let entry: EntryRecord | undefined
  if (ref === 'latest') {
    let cursor: Parameters<Tx['scanEntries']>[2]
    do {
      const page = await tx.scanEntries({ conversationId: from }, SCAN_PAGE, cursor)
      entry = page.items.find((item) => imagesOf(item).length > 0)
      cursor = page.next
    } while (!entry && cursor !== undefined)
    if (!entry) throw new Error('images: "latest" found no entry with images in this conversation')
  } else {
    if (!Number.isInteger(ref) || ref < 1)
      throw new Error('images must be "latest" or the id of an entry with images')
    entry = (
      await tx.scanEntries(
        { conversationId: from, minEntryId: ref as EntryId, maxEntryId: ref as EntryId },
        1,
      )
    ).items[0]
    if (!entry) throw new Error(`images: entry ${ref} is not in this conversation`)
  }
  const images = imagesOf(entry)
  if (!images.length) throw new Error(`images: entry ${entry.id} has no images`)
  if (images.length > maxImages)
    throw new Error(
      `images: entry ${entry.id} has ${images.length} images; at most ${maxImages} go along`,
    )
  for (const image of images)
    if (
      !imageMimeTypes.includes(image.mimeType) ||
      Buffer.byteLength(image.data, 'base64') > maxImageBytes
    )
      throw new Error(`images: entry ${entry.id} has an unsupported image or one over 2 MiB`)
  return { entry: entry.id, count: images.length }
}
// The receipt commits with the message, closing the gap before api.memo records its id.
const Sent = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.sent-calls',
  checkpointWhen: () => false,
  version: 1,
  scope: 'task',
  initial: () => ({ ids: {} }),
})
// Pipeline requests outlive their calling task, so their receipts belong to the sender conversation.
const Requests = defineDoc<{ ids: Record<string, number> }>({
  kind: 'board.requests',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ ids: {} }),
})
/** What this instance told another project's Ultimate, kept until its answer arrives, apart from the bounded log. */
type Told = { message: Message; answer?: number }
/**
 * Ultimate-to-Ultimate bookkeeping by message key, kept apart from the Messages log, which drops old messages: `received`
 * maps each incoming key to its message so a repeated post delivers once; `told` holds each outgoing reply-enabled
 * message until its one answer arrives. Neither is pruned by count: these messages are few and small.
 */
const RemoteDoc = defineDoc<{ received: Record<string, number>; told: Record<string, Told> }>({
  kind: 'board.remote',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ received: {}, told: {} }),
})
/**
 * Who started a branch through `branch`, so its later final answers reach that conversation. `yielded` is the newest
 * generation observed, so a replayed hook creates no second observer.
 */
const Started = defineDoc<{ by?: number; yielded?: number }>({
  kind: 'board.started',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
/** A reply-enabled message to the user that the user has neither answered nor dismissed yet. */
const openQuestion = (m: Message) => m.to === 'user' && m.reply && m.state === 'delivered'
/** A question in one line: its decisions' topics, else its first line that asks something, else its first line, clipped. */
export const gist = (text: string) => {
  const decisions = parseDecisions(text)
  const lines = decisions.length
    ? [`decisions ${decisions.map((d) => `${d.ref}. ${d.topic}`).join('; ')}`]
    : text
        .split('\n')
        .map((line) => line.replace(/\*\*/g, '').trim())
        .filter(Boolean)
  const line = lines.find((candidate) => candidate.includes('?')) ?? lines[0] ?? ''
  return line.length > 100 ? `${line.slice(0, 99)}…` : line
}
/**
 * The input that starts a run of the conversation that asked the user questions goes in after a line naming those still
 * open, so the agent treats them as unanswered. A per-input entry, not a system-prompt section, keeps the prompt cached.
 */
export async function openQuestionsNote(tx: Tx, conversationId: ConversationId, now: number) {
  const open = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.filter(
    (m) => openQuestion(m) && m.from === conversationId,
  )
  if (!open.length) return undefined
  const ago = (at: number) => {
    const minutes = Math.max(0, Math.round((now - at) / 60_000))
    return minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes}m ago`
        : `${Math.round(minutes / 60)}h ago`
  }
  const text = `Open questions to the user, unanswered until they answer or dismiss them:\n${open
    .map((m) => `- message ${m.id}: ${gist(m.text)} (asked ${ago(m.at)})`)
    .join('\n')}`
  return {
    entries: [
      {
        kind: 'board.open',
        data: { ids: open.map((m) => m.id) },
        model: [{ role: 'user' as const, content: text, timestamp: now }],
      },
    ],
  }
}
async function append(tx: Tx, input: Omit<Message, 'id' | 'at'>) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  const message = { ...input, id: log.next++, at: Date.now() }
  log.messages.push(message)
  if (log.messages.length > 300) log.messages.splice(0, log.messages.length - 300)
  return message
}
type Recipient = NonNullable<
  Awaited<ReturnType<ReturnType<ExtensionHost['harness']>['conversation']>>
>
/**
 * Triage for the primary agent: whether message `m` needs it to act now. A model failure or timeout acts, so the agent
 * wakes as it would without triage. The model and response are memos, so a resumed task asks once.
 */
async function assess(
  host: ExtensionHost,
  runtime: Pick<
    TaskRuntime<unknown, unknown, unknown, object>,
    'memo' | 'models' | 'signal' | 'taskId' | 'conversationId'
  >,
  model: SummaryModel,
  input: { kind: 'message' | 'reply'; from: string; text: string },
  ctx: Context,
): Promise<{ verdict: Verdict; response?: ResponseReceipt }> {
  const conversations = host.need(ConversationsApi)
  let response = await runtime.memo<ResponseReceipt>('triage-response', ctx)
  const ask = () =>
    conversations.askSummaryModel(
      runtime.models,
      TRIAGE_SYSTEM,
      triageInput(input.kind, input.from, input.text),
      // The timeout starts with the call, not while the gate holds it.
      AbortSignal.any([runtime.signal, AbortSignal.timeout(30_000)]),
      { model, response, save: (received) => runtime.memo('triage-response', received, ctx) },
    )
  // The gate (pause, when enabled) holds the call while paused and counts it as running while it runs.
  const gate = host.want(Gate)
  const call = { task: runtime.taskId, conversationId: runtime.conversationId, what: 'triage' }
  try {
    response = gate ? await gate.work(call, ask, runtime.signal) : await ask()
    if (response.stopReason !== 'stop') throw new Error(`Triage stopped: ${response.stopReason}`)
    return { verdict: parseVerdict(response.text), response }
  } catch (error) {
    if (runtime.signal.aborted) throw error
    // Triage only saves a turn: when it cannot decide, the agent wakes as it would without triage.
    return { verdict: { verdict: 'act', reason: 'assessment failed; woke as usual' }, response }
  }
}
/** The primary agent's conversation, whose incoming messages are triaged. */
async function primaryConversation(host: ExtensionHost, ctx: Context) {
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  return standing?.ultimate
}
/**
 * The summary model a triage asks, chosen once per task. Without one, nothing is gated: the message wakes the agent as
 * it would without triage.
 */
async function triageModel(
  host: ExtensionHost,
  runtime: Pick<TaskRuntime<unknown, unknown, unknown, object>, 'memo'>,
  ctx: Context,
) {
  const kept = await runtime.memo<SummaryModel | false>('triage-model', ctx)
  if (kept !== undefined) return kept || undefined
  const chosen = await host.need(ConversationsApi).summaryModel()
  return (await runtime.memo('triage-model', chosen ?? false, ctx)) || undefined
}
/** Record message `id`'s verdict, emitting `board.triaged` once, when the log still holds it. */
async function recordTriage(host: ExtensionHost, tx: Tx, id: number, triage: Triage) {
  const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find((m) => m.id === id)
  if (!stored || (stored.triage && stored.triage.verdict !== 'assessing')) return
  stored.triage = triage
  if (
    triage.verdict !== 'assessing' &&
    (typeof stored.from === 'number' || stored.from === 'remote') &&
    typeof stored.to === 'number'
  )
    await host.emit(tx, Triaged, {
      message: id,
      from: stored.from,
      to: stored.to,
      verdict: triage.verdict,
      reason: triage.reason ?? '',
    })
}
type TriageRuntime = Pick<
  TaskRuntime<unknown, unknown, unknown, object>,
  'memo' | 'models' | 'signal' | 'commit' | 'taskId' | 'conversationId'
>
/**
 * After a triaged message was written as context (no run), assess it and record the verdict: `act` wakes the agent with
 * one short input that points at it, `fyi` leaves it for the next input. Returns the wake's answer, if one ran.
 */
async function settleTriage(
  host: ExtensionHost,
  runtime: TriageRuntime,
  recipient: Recipient,
  input: {
    id: number
    kind: 'message' | 'reply'
    fromLabel: string
    text: string
    whenBusy: 'steer' | 'followUp'
  },
  model: SummaryModel,
  ctx: Context,
) {
  // The verdict is a memo, so a replay after a failed or timed-out assessment wakes as decided, never reassesses.
  let verdict = await runtime.memo<Verdict>('triage-verdict', ctx)
  if (!verdict) {
    const assessed = await assess(
      host,
      runtime,
      model,
      { kind: input.kind, from: input.fromLabel, text: input.text },
      ctx,
    )
    verdict = await runtime.memo('triage-verdict', assessed.verdict, ctx)
  }
  // The memoized response's usage commits with the verdict's record, once: only while the message still assesses,
  // so a replay after either memo or this commit neither drops nor repeats it.
  const response = await runtime.memo<ResponseReceipt>('triage-response', ctx)
  const decided = verdict
  // The verdict commits before the wake, so the row shows it while the run starts.
  await runtime.commit(async (tx) => {
    const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
      (m) => m.id === input.id,
    )
    if (stored?.triage?.verdict === 'assessing')
      await host.need(ConversationsApi).accountResponse(tx, recipient.id, response)
    await recordTriage(host, tx, input.id, decided)
    return undefined
  }, ctx)
  if (verdict.verdict === 'fyi') return undefined
  const wake = await recipient.submit(
    {
      type: 'input',
      requestId: `board-wake:${input.id}`,
      whenBusy: input.whenBusy,
      entry: { kind: 'board.wake', data: { id: input.id, reason: verdict.reason } },
      content: `The ${input.kind} from ${input.fromLabel} above needs you now${verdict.reason ? `: ${verdict.reason}` : ''}.`,
    },
    ctx,
  )
  if (input.kind === 'reply') return undefined
  const settled = await wake.wait(ctx)
  return settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined
}
function delivery(host: ExtensionHost) {
  const refresh = async (id: number, ctx: Context) => {
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
    const name = Object.keys(index ?? {}).find((candidate) => index![candidate] === id)
    if (name === undefined) return
    const service = host.need(SubagentsApi)
    // A retired agent's conversation stays addressable by id until the next open prunes it.
    if ((await service.residents(ctx)).some((agent) => agent.name === name))
      await service.standing(name, ctx)
  }
  return defineTask<
    {
      message: Message
      steer: boolean
      note: boolean
      fromLabel: string
      toLabel: string
      /** Another project's Ultimate answered `message`: deliver only this reply. */
      reply?: { message: Message; failed: boolean }
    },
    { phase: 'deliver' } | { phase: 'reply'; message: Message; failed: boolean },
    null
  >({
    name: 'board.delivery',
    version: 1,
    initial: (input) => (input.reply ? { phase: 'reply', ...input.reply } : { phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const m = task.input.message
        if (typeof m.to !== 'number') throw new Error('Only conversations take a delivery')
        await refresh(m.to, ctx)
        const recipient = await host.harness().conversation(m.to as ConversationId, ctx)
        if (!recipient) throw new Error(`Unknown conversation #${m.to}`)
        // Entries never change, so a replayed delivery attaches the same images.
        const images = m.images
          ? imagesOf(await host.harness().commit((tx) => tx.entry(m.images!.entry), ctx))
          : []
        const entry = {
          kind: 'board.message',
          data: {
            id: m.id,
            from: m.from,
            text: m.text,
            reply: m.reply,
            delivery: task.input.note ? 'note' : task.input.steer ? 'steer' : 'followUp',
            ...(images.length ? { images: images.length } : {}),
            ...(m.remote ? { remote: m.remote } : {}),
          },
        }
        const body = task.input.note
          ? `Note from ${task.input.fromLabel} (one-way update, no answer goes back):\n${m.text}`
          : `Message from ${task.input.fromLabel}${m.from === 'remote' ? " (another project's Ultimate, not the user)" : ''}:\n${m.text}${m.reply ? `\nAnswer here; your answer is sent to ${task.input.fromLabel} automatically. Do not use message to reply.` : `\nOne-way message: ${task.input.fromLabel} expects no answer, and your answer here is not sent to it. If it needs to hear from you, message it.`}`
        const content = images.length ? [{ type: 'text' as const, text: body }, ...images] : body
        const requestId = `board:${m.id}`
        // A conversation's message to the primary agent is triaged. One that expects a reply or asks for a decision
        // acts at once; another one-way message goes in as context and wakes the agent only when the summary model
        // says act. Notes never wake; without a summary model nothing is gated.
        const triaged =
          (typeof m.from === 'number' || m.from === 'remote') &&
          !task.input.note &&
          m.to === (await primaryConversation(host, ctx))
        const sure: Verdict | undefined = !triaged
          ? undefined
          : m.reply
            ? { verdict: 'act', reason: 'expects a reply' }
            : declared(m.text)
        const triager = triaged && !sure ? await triageModel(host, runtime, ctx) : undefined
        const gated = triager !== undefined
        const receipt =
          task.input.note || gated
            ? await recipient.submit(
                {
                  type: 'write',
                  requestId,
                  entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
                },
                ctx,
              )
            : await recipient.submit(
                {
                  type: 'input',
                  requestId,
                  whenBusy: task.input.steer ? 'steer' : 'followUp',
                  entry,
                  content,
                },
                ctx,
              )
        {
          // Admission can precede placement while a recipient is busy. Watch its durable queue,
          // not a timer, so messages become delivered only after leaving the queue.
          const inbox = await runtime.watchDoc(InboxDoc, recipient.id, ctx)
          if (inbox) {
            let wake!: () => void
            const placed = new Promise<void>((done) => {
              wake = done
            })
            const inspect = (value: typeof inbox.value) => {
              if (!value?.items.some((item) => item.id === receipt.id)) wake()
            }
            inbox.start(async (value) => {
              inspect(value)
            })
            try {
              inspect(inbox.value)
              await awaitWithContext(placed, ctx)
            } finally {
              await inbox.stop()
            }
          }
          const placement = await receipt.status(ctx)
          await runtime.commit(async (tx) => {
            const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (stored) {
              stored.state = placement.status === 'unanswered' ? 'failed' : 'delivered'
              if ('entry' in placement && placement.entry !== undefined)
                stored.entry = placement.entry
            }
            if (triaged && placement.status !== 'unanswered')
              await recordTriage(
                host,
                tx,
                m.id,
                triager
                  ? { verdict: 'assessing' }
                  : (sure ?? { verdict: 'act', reason: 'no summary model to assess it' }),
              )
            if (task.input.note) return terminal
            return undefined
          }, ctx)
          if (triager) {
            const answer =
              placement.status === 'unanswered'
                ? undefined
                : await settleTriage(
                    host,
                    runtime,
                    recipient,
                    {
                      id: m.id,
                      kind: 'message',
                      fromLabel: task.input.fromLabel,
                      text: m.text,
                      whenBusy: task.input.steer ? 'steer' : 'followUp',
                    },
                    triager,
                    ctx,
                  )
            await runtime.commit(async (tx) => {
              const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
                (item) => item.id === m.id,
              )
              if (stored && answer !== undefined) stored.answer = answer
              return terminal
            }, ctx)
            return
          }
          if (task.input.note) return
        }
        const settled = await receipt.wait(ctx)
        await runtime.commit(async (tx) => {
          const answer =
            settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined
          if (!m.reply) {
            const original = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (original && answer !== undefined) original.answer = answer
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          const model =
            answer === undefined ? undefined : (await tx.entry(AssistantEntry, answer))?.model?.[0]
          const text =
            model?.role === 'assistant'
              ? model.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
              : ''
          const failed =
            !text.trim() ||
            model?.role !== 'assistant' ||
            model.stopReason === 'error' ||
            model.stopReason === 'aborted'
          const error = failed
            ? `ended its turn without an answer (${settled.status === 'unanswered' ? settled.reason : settled.status})`
            : undefined
          const original = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )
          if (original) {
            original.state = failed ? 'failed' : 'answered'
            if (answer !== undefined) original.answer = answer
            if (error !== undefined) original.error = error
            if ('entry' in settled && settled.entry !== undefined) original.entry = settled.entry
          }
          const response = await append(tx, {
            from: m.to,
            to: m.from,
            text: error ?? text,
            reply: false,
            re: m.id,
            state: failed ? 'failed' : 'sent',
            ...(answer ? { answer } : {}),
            ...(error ? { error } : {}),
            ...(m.remote ? { remote: m.remote } : {}),
          })
          return { status: 'running', checkpoint: { phase: 'reply', message: response, failed } }
        }, ctx)
      },
      reply: async (task, runtime, ctx) => {
        const { message: m, failed } = task.state.checkpoint
        if (m.to === 'remote') {
          // The answer travels back to the Ultimate that asked; it delivers it once, as a reply that expects none.
          let error: string | undefined
          try {
            const target = await locate(host, m.remote!.project, m.remote!.machine)
            if ('current' in target) throw new Error(`${m.remote!.project} is this project`)
            await postAction(
              target,
              'messages',
              'remoteReply',
              { key: m.remote!.key, text: m.text, failed },
              runtime.signal,
            )
          } catch (cause) {
            if (runtime.signal.aborted) throw cause
            error = `The reply did not reach ${remoteLabel(m.remote!)}: ${cause instanceof Error ? cause.message : String(cause)}`
          }
          await runtime.commit(async (tx) => {
            const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
              (item) => item.id === m.id,
            )
            if (stored) {
              stored.state = error || failed ? 'failed' : 'delivered'
              if (error) stored.error = error
            }
            return terminal
          }, ctx)
          return
        }
        if (m.to !== 'user') {
          await refresh(m.to, ctx)
          // A reply to the primary agent is triaged like a message: a failure, a decision or an answer to its own
          // question acts at once; another reply goes in as context and wakes it only when the summary model says act.
          const triaged = m.to === (await primaryConversation(host, ctx))
          let sure: Verdict | undefined
          if (triaged)
            // The task input keeps the message this replies to, so the log's bound never drops it.
            sure =
              declared(m.text, failed) ??
              (needsDecision(task.input.message.text)
                ? { verdict: 'act', reason: 'answers your question' }
                : undefined)
          const triager = triaged && !sure ? await triageModel(host, runtime, ctx) : undefined
          if (triaged)
            await runtime.commit(async (tx) => {
              await recordTriage(
                host,
                tx,
                m.id,
                triager
                  ? { verdict: 'assessing' }
                  : (sure ?? { verdict: 'act', reason: 'no summary model to assess it' }),
              )
              return undefined
            }, ctx)
          // The harness handle, not the task runtime's: triage writes context first, which only it accepts.
          const sender = await host.harness().conversation(m.to as ConversationId, ctx)
          const entry = {
            kind: 'board.reply',
            data: {
              id: m.id,
              re: m.re!,
              from: m.from,
              text: m.text,
              failed,
              ...(m.remote ? { remote: m.remote } : {}),
            },
          }
          const content = `Reply from ${task.input.toLabel} to your message ${m.re}${failed ? ' (failed)' : ''}:\n${m.text}`
          const requestId = `board-reply:${m.id}`
          if (sender && triager) {
            await sender.submit(
              {
                type: 'write',
                requestId,
                entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
              },
              ctx,
            )
            await settleTriage(
              host,
              runtime,
              sender,
              {
                id: m.id,
                kind: 'reply',
                fromLabel: task.input.toLabel,
                text: m.text,
                whenBusy: 'steer',
              },
              triager,
              ctx,
            )
          } else if (sender)
            await sender.submit(
              { type: 'input', requestId, whenBusy: 'steer', entry, content },
              ctx,
            )
        }
        await runtime.commit(async (tx) => {
          const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
            (item) => item.id === m.id,
          )
          if (stored && !failed) stored.state = 'delivered'
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const
/**
 * After a branch's run, its final answer reaches the conversation that started it, unless that answer already does:
 * as the answer to the starter's reply-enabled message, or because the run messaged the starter itself. Routing only
 * goes from a branch to its starter, which existed first, and a routed message is one-way: it cannot ping-pong.
 */
function route(host: ExtensionHost) {
  return defineTask<
    { generation: TaskId<GenerationResult>; inputs: SubmissionId[]; by: number },
    { phase: 'observe' },
    null
  >({
    name: 'board.route',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: async (task, runtime, ctx) => {
        const settled = await runtime.waitForTask(task.input.generation, ctx)
        if (settled.state.outcome.status !== 'completed') {
          await runtime.commit(() => terminal, ctx)
          return
        }
        const answer = settled.state.outcome.result.entryId
        const inputs = await Promise.all(
          task.input.inputs.map(async (id) =>
            (await host.harness().submission(id, ctx))?.status(ctx),
          ),
        )
        const { by } = task.input
        const id = runtime.conversationId
        const text = await host.harness().commit(async (tx) => {
          // A continued generation's answer is no run's final answer: only inputs it settled make one.
          const answered = inputs.flatMap((input) =>
            input?.type === 'input' && input.status === 'done' && input.answer === answer
              ? [input.entry]
              : [],
          )
          let since = Number.POSITIVE_INFINITY
          let replies = 0
          for (const entryId of answered) {
            const entry = await tx.entry(entryId)
            // board.delivery returns the answer to the starter's reply-enabled message; a one-way one gets none.
            const data = entry?.data as { from?: unknown; reply?: unknown } | undefined
            if (entry?.kind === 'board.message' && data?.from === by && data.reply === true)
              return undefined
            if (entry?.kind === 'board.reply' && data?.from === by) replies++
            since = Math.min(since, entry?.model?.[0]?.timestamp ?? since)
          }
          // A run woken only by the starter's own replies reacts to what the starter already knows.
          if (!answered.length || replies === answered.length) return undefined
          const message = (await tx.entry(answer))?.model?.[0]
          if (
            message?.role !== 'assistant' ||
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          )
            return undefined
          const until = message.timestamp
          // Only tool calls count: an earlier run's routed answer can land after this run's input.
          const messaged = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
            (m) =>
              m.from === id &&
              m.to === by &&
              m.call !== undefined &&
              m.at >= since &&
              m.at <= until,
          )
          if (messaged) return undefined
          return message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
        }, ctx)
        if (text?.trim())
          await send(
            host,
            id,
            { to: `#${by}`, text, reply: false },
            ctx,
            undefined,
            undefined,
            `route:${answer}`,
            undefined,
            !needsDecision(text),
          )
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
/** The conversation that started `id` as a subagent, which is the only one it may message. */
async function parentOf(host: ExtensionHost, id: number, ctx: Context) {
  const owner = (await host.harness().commit((tx) => tx.conversation(id as ConversationId), ctx))
    ?.owner?.conversationId
  if (owner === undefined) return undefined
  return (await host.harness().snapshot(Subagents, owner, ctx))?.agents[String(id)]
    ? owner
    : undefined
}
async function lander(host: ExtensionHost, ctx: Context) {
  const checkout = await isolatable(host.projectRoot)
  if ('reason' in checkout) return undefined
  return (await host.harness().snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, ctx))
    ?.landerConversations[checkout.source]
}
async function senderName(host: ExtensionHost, id: number | 'user', ctx: Context) {
  if (id === 'user') return 'user'
  if (typeof id !== 'number') return 'another Ultimate'
  const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const name = Object.keys(index ?? {}).find((candidate) => index?.[candidate] === id)
  const workspace = await host
    .harness()
    .snapshot(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID, ctx)
  const label =
    name ??
    (Object.values(workspace?.landerConversations ?? {}).includes(id) ? 'lander' : undefined)
  return `#${id}${label ? ` (@${label})` : ''}`
}
async function resolve(host: ExtensionHost, to: string, from: number | 'user', ctx: Context) {
  if (to === 'user') return to
  let id: number | undefined
  if (to === '@lander') id = await lander(host, ctx)
  else if (to.startsWith('@')) {
    const service = host.need(SubagentsApi)
    const valid = await service.residents(ctx)
    if (!valid.some((item) => `@${item.name}` === to))
      throw new Error(
        `Unknown address ${to}. Valid standing agents: ${valid.map((item) => `@${item.name}`).join(', ') || '(none)'}`,
      )
    id = await service.standing(to.slice(1), ctx)
  } else if (/^#?\d+$/.test(to)) id = Number(to.replace('#', ''))
  if (id === undefined) throw new Error(`No recipient for ${to}`)
  if (id === from) throw new Error('You cannot message yourself')
  await host.harness().commit(async (tx) => {
    if (!(await tx.conversation(id as ConversationId)))
      throw new Error(`Unknown conversation #${id}`)
    const roots = host.doc('lineage.roots')
    const tally = host.doc('lineage.tally')
    if (roots && tally) {
      const index = (await tx.doc(roots, ROOT_CONVERSATION_ID)) as { roots?: number[] }
      const state = (await tx.doc(tally, id as ConversationId)) as {
        since?: number
        converting?: unknown
      }
      if (index.roots?.includes(id) && (state.since !== undefined || state.converting))
        throw new Error(`#${id} is a tally and takes no inputs; use note instead`)
    }
  }, ctx)
  return id
}
async function send(
  host: ExtensionHost,
  from: number | 'user',
  input: {
    to: string
    text: string
    reply?: boolean
    steer?: boolean
    re?: number
    images?: ImagesRef
    /** Images belong to the caller, even when another conversation is credited as sender. */
    imagesFrom?: ConversationId
    /** The user's reply `re` dismisses that question instead of answering it. */
    dismiss?: boolean
  },
  ctx: Context,
  taskId?: TaskId,
  callId?: string,
  requestId?: string,
  answerId?: number,
  note?: boolean,
  device?: Device,
) {
  if (requestId !== undefined && from !== 'user') {
    const sent = await host.harness().snapshot(Requests, from as ConversationId, ctx)
    if (sent?.ids[requestId] !== undefined) return sent.ids[requestId]
  }
  if (taskId !== undefined) {
    const sent = await host.harness().snapshot(Sent, taskId, ctx)
    if (callId !== undefined && sent?.ids[callId] !== undefined) return sent.ids[callId]
  }
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  const primaryId = standing?.ultimate
  // The primary agent's messages to a busy conversation almost always steer it: new scope, a decision, a stop.
  const steer = input.steer ?? (from !== 'user' && from === primaryId)
  if (input.to === 'user') {
    if (from !== primaryId)
      throw new Error(
        'Only @ultimate messages the user; send this to @ultimate (reply: false) and it relays it.',
      )
  }
  if (!input.text.trim()) throw new Error('Message text must not be empty')
  // Checked before resolving, which may create a standing agent's conversation.
  const parent = from === 'user' ? undefined : await parentOf(host, from, ctx)
  if (parent !== undefined && input.to.replace(/^#/, '') !== String(parent))
    throw new Error(
      `Subagents report to the conversation that started them: message only #${parent}. Your final answer reaches it anyway.`,
    )
  const to = await resolve(host, input.to, from, ctx)
  const fromLabel = await senderName(host, from, ctx)
  const toLabel = await senderName(host, to, ctx)
  return host.harness().commit(async (tx) => {
    const receipt = taskId === undefined ? undefined : await tx.doc(Sent, taskId)
    const requests =
      requestId === undefined || from === 'user'
        ? undefined
        : await tx.doc(Requests, from as ConversationId)
    if (requestId !== undefined && requests?.ids[requestId] !== undefined)
      return requests.ids[requestId]
    if (callId !== undefined && receipt?.ids[callId] !== undefined) return receipt.ids[callId]
    if (answerId !== undefined) {
      const original = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (m) => m.id === answerId,
      )
      if (!original || !openQuestion(original))
        throw new Error('These questions are no longer open')
    }
    if (input.images !== undefined && (from === 'user' || to === 'user'))
      throw new Error('images go along only to conversations and agents')
    const images =
      input.images === undefined
        ? undefined
        : await resolveImages(tx, input.imagesFrom ?? (from as ConversationId), input.images)
    // Only a Reply answers a question to the user, and only the one it replies to; a dismissal closes it unanswered.
    if (from === 'user' && input.re !== undefined)
      for (const m of (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages)
        if (openQuestion(m) && m.id === input.re) m.state = input.dismiss ? 'dismissed' : 'answered'
    if (from !== 'user' && input.reply !== false) {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      const pending = log.messages.find(
        (m) =>
          m.to === from &&
          m.from === to &&
          m.reply &&
          (m.state === 'sent' || m.state === 'delivered'),
      )
      if (pending)
        throw new Error(
          `Your answer to ${toLabel}'s message ${pending.id} is sent back automatically. Answer instead of messaging.`,
        )
    }
    const message = await append(tx, {
      from,
      to,
      text: input.text,
      reply: input.reply ?? true,
      state: to === 'user' ? 'delivered' : 'sent',
      ...(input.re === undefined ? {} : { re: input.re }),
      ...(callId === undefined ? {} : { call: callId }),
      ...(images ? { images } : {}),
    })
    await host.emit(tx, MessageSent, { message: message.id, from, to, reply: message.reply, steer })
    // The user's answer or dismissal is their input to the asker; the message's `entry` names it once delivered.
    if (from === 'user' && answerId !== undefined && typeof to === 'number')
      await host.emit(tx, UserInputEvent, {
        conversation: to,
        kind: input.dismiss ? 'dismiss' : 'answer',
        message: message.id,
        length: input.dismiss ? 0 : input.text.length,
        ...device,
      })
    if (to === 'user' && message.reply && from !== 'user')
      await host.emit(tx, Asked, { message: message.id, from })
    if (to !== 'user')
      await tx.createTask(
        delivery(host),
        {
          message,
          steer,
          note: note ?? (parent === to && input.reply === false),
          fromLabel,
          toLabel,
        },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
    if (receipt && callId !== undefined) receipt.ids[callId] = message.id
    if (requests && requestId !== undefined) requests.ids[requestId] = message.id
    return message.id
  }, ctx)
}
/** How another project's Ultimate is named, as data.tsx names it in the browser. */
const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`
const unknownKey = () =>
  new Error('No message from this Ultimate that expects a reply has that key')
const field = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must be a nonempty string of at most ${max} characters`)
  return value
}
/**
 * From the primary agent's conversation `from`, message another project's Ultimate. The message is logged here first,
 * so an answer that arrives before the post returns finds it by its key.
 */
async function tell(
  host: ExtensionHost,
  from: number,
  input: { project: string; machine?: string; text: string; reply?: boolean },
  ctx: Context,
  signal?: AbortSignal,
) {
  const standing = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, ctx)
  if (standing?.ultimate !== from)
    throw new Error("Only @ultimate tells another project's Ultimate")
  if (!input.text.trim()) throw new Error('Message text must not be empty')
  const target = await locate(host, input.project, input.machine)
  if ('current' in target)
    throw new Error(`${input.project} is this project; message its agents with message`)
  const self = await selfAddress(host)
  const reply = input.reply ?? true
  // An Ultimate answering another's question answers it; telling back would start a conversation between agents.
  const asking = (
    (await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx))?.messages ?? []
  ).find(
    (m) =>
      m.from === 'remote' &&
      m.to === from &&
      m.reply &&
      m.remote?.project === target.name &&
      (m.state === 'sent' || m.state === 'delivered'),
  )
  if (asking)
    throw new Error(
      `Your answer to ${remoteLabel(asking.remote!)}'s message ${asking.id} is sent back automatically. Answer instead of telling.`,
    )
  const remote = {
    project: target.name,
    machine: target.machine ?? self.machine,
    key: randomUUID(),
  }
  const id = await host.harness().commit(async (tx) => {
    const message = await append(tx, {
      from,
      to: 'remote',
      text: input.text,
      reply,
      state: 'sent',
      remote,
    })
    if (reply) (await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)).told[remote.key] = { message }
    await host.emit(tx, MessageSent, {
      message: message.id,
      from,
      to: 'remote',
      reply,
      steer: true,
    })
    return message.id
  }, ctx)
  const settle = (change: (stored: Message) => void) =>
    host.harness().commit(async (tx) => {
      const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (m) => m.id === id,
      )
      if (stored) change(stored)
    }, ctx)
  let delivered: number
  try {
    delivered = (await postAction(
      target,
      'messages',
      'remote',
      { key: remote.key, text: input.text, reply, from: self },
      signal,
    )) as number
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await settle((stored) => {
      stored.state = 'failed'
      stored.error = message
    })
    await host.harness().commit(async (tx) => {
      delete (await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)).told[remote.key]
    }, ctx)
    throw error
  }
  await settle((stored) => {
    stored.remote = { ...stored.remote!, id: delivered }
    // A quick answer may have arrived first.
    if (stored.state === 'sent') stored.state = 'delivered'
  })
  return { message: id, delivered }
}
export const actions = {
  [CallerAction.name]: implementAction(CallerAction, async (args, { host }) => {
    const { conversation, call } = (args ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(conversation) || (conversation as number) < 1)
      throw new Error('conversation must be a conversation id')
    if (typeof call !== 'string' || !call) throw new Error('call must be a tool call id')
    // A nested codemode call (`<script>/<n>`) was made by the response that called the script.
    const id = call.split('/')[0]
    return host.harness().commit(async (tx) => {
      let cursor: Parameters<Tx['scanEntries']>[2]
      do {
        const page = await tx.scanEntries(
          { conversationId: conversation as ConversationId },
          SCAN_PAGE,
          cursor,
        )
        const found = callerOf(page.items, id)
        if (found) return { entry: found.id }
        cursor = page.next
      } while (cursor !== undefined)
      return {}
    }, BACKGROUND_CONTEXT)
  }),
  /**
   * `{ key, text, reply, from: { project, machine } }`: another project's Ultimate messages this instance's primary
   * agent, the only conversation it can reach. A repeated `key` returns the first delivery's id.
   */
  async remote(args: JsonValue, { host }: ActionContext) {
    const input = (args ?? {}) as Record<string, unknown>
    const from = (input.from ?? {}) as Record<string, unknown>
    const key = field(input.key, 'key', 100)
    const body = field(input.text, 'text', 100_000)
    const sender = {
      project: field(from.project, 'from.project', 200),
      machine: field(from.machine, 'from.machine', 200),
    }
    if (typeof input.reply !== 'boolean') throw new Error('reply must be a boolean')
    const reply = input.reply
    const to = await host.need(SubagentsApi).standing('ultimate', BACKGROUND_CONTEXT)
    const toLabel = await senderName(host, to, BACKGROUND_CONTEXT)
    return host.harness().commit(async (tx) => {
      const { received } = await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)
      if (Object.hasOwn(received, key)) return received[key]
      const message = await append(tx, {
        from: 'remote',
        to,
        text: body,
        reply,
        state: 'sent',
        remote: { ...sender, key },
      })
      received[key] = message.id
      await host.emit(tx, MessageSent, {
        message: message.id,
        from: 'remote',
        to,
        reply,
        steer: true,
      })
      await tx.createTask(
        delivery(host),
        { message, steer: true, note: false, fromLabel: remoteLabel(sender), toLabel },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
      return message.id
    }, BACKGROUND_CONTEXT)
  },
  /**
   * `{ key, text, failed }`: the Ultimate this instance told answers its reply-enabled message `key`. The answer reaches
   * the teller as a reply that expects none; a second answer returns the first one's id, and a message that expects no
   * reply refuses it, so two Ultimates cannot keep answering each other.
   */
  async remoteReply(args: JsonValue, { host }: ActionContext) {
    const input = (args ?? {}) as Record<string, unknown>
    const key = field(input.key, 'key', 100)
    const body = field(input.text, 'text', 100_000)
    const failed = input.failed === true
    const seen = (
      await host.harness().snapshot(RemoteDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    )?.told
    if (!seen || !Object.hasOwn(seen, key)) throw unknownKey()
    const fromLabel = await senderName(host, seen[key].message.from as number, BACKGROUND_CONTEXT)
    return host.harness().commit(async (tx) => {
      const { told } = await tx.doc(RemoteDoc, ROOT_CONVERSATION_ID)
      if (!Object.hasOwn(told, key)) throw unknownKey()
      const entry = told[key]
      if (entry.answer !== undefined) return entry.answer
      const original = entry.message
      const stored = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (m) => m.id === original.id,
      )
      if (stored) stored.state = failed ? 'failed' : 'answered'
      const response = await append(tx, {
        from: 'remote',
        to: original.from,
        text: body,
        reply: false,
        re: original.id,
        state: 'sent',
        remote: original.remote!,
      })
      entry.answer = response.id
      await tx.createTask(
        delivery(host),
        {
          message: original,
          steer: true,
          note: false,
          fromLabel,
          toLabel: remoteLabel(original.remote!),
          reply: { message: response, failed },
        },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      )
      return response.id
    }, BACKGROUND_CONTEXT)
  },
  async addresses(_args: unknown, { host }: ActionContext) {
    const agents = await host.need(SubagentsApi).residents(BACKGROUND_CONTEXT)
    const index = await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    const conversations = host
      .conversations()
      .filter((c) => !c.parentConversationId)
      .toSorted((a, b) => (b.inputAt ?? b.id) - (a.inputAt ?? a.id))
      .slice(0, 50)
    return {
      agents: agents.map((a) => ({
        ...a,
        ...(index?.[a.name] === undefined ? {} : { id: index[a.name] }),
      })),
      lander: await lander(host, BACKGROUND_CONTEXT),
      conversations,
    }
  },
}
/** Only another instance posts these, over its API: no agent here can pose as a remote Ultimate. */
export const userActions = ['remote', 'remoteReply']
const imagesParameter = Type.Union([Type.Literal('latest'), Type.Integer({ minimum: 1 })], {
  description:
    'Forward images from your conversation: "latest" for the newest input or tool result (screenshot) with images, or that entry\'s id.',
})
export default function messages(host: ExtensionHost) {
  // Core, always on; resolved where they are called, declared here so the catalogue lists them.
  host.need(LineageApi)
  host.need(SubagentsApi)
  host.need(WorkspacesApi)
  // The extension's own point, resolved where triage calls the model.
  host.want(Gate)
  // The lander's deploy handoff, through workspaces' extension point, so workspaces does not depend on messages.
  host.implement(Handoff, {
    send: (from, input, requestId, ctx) =>
      send(host, from, input, ctx, undefined, undefined, requestId),
  })
  host.implement(MessagesApi, {
    answer: async (messageId, text, ctx, device) => {
      const log = await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
      const message = log?.messages.find((m) => m.id === messageId)
      if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
      return send(
        host,
        'user',
        { to: `#${message.from}`, text, re: messageId },
        ctx,
        undefined,
        undefined,
        undefined,
        messageId,
        undefined,
        device,
      )
    },
    dismiss: async (messageId, ctx, device) => {
      const log = await host.harness().snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
      const message = log?.messages.find((m) => m.id === messageId)
      if (!message || !openQuestion(message)) throw new Error('These questions are no longer open')
      // A one-way note: the asker reads it with its next input, and no run starts for it.
      return send(
        host,
        'user',
        {
          to: `#${message.from}`,
          text: `The user dismissed your question (message ${messageId}): ${gist(message.text)}\nIt is closed without an answer; ask again only if it still matters.`,
          reply: false,
          re: messageId,
          dismiss: true,
        },
        ctx,
        undefined,
        undefined,
        undefined,
        messageId,
        true,
        device,
      )
    },
    send: (from, input, requestId, ctx) =>
      send(host, from, input, ctx, undefined, undefined, requestId),
    tell: (from, input, ctx, signal) => tell(host, from, input, ctx, signal),
  })
  return defineExtension({
    name: 'messages',
    tasks: [delivery(host), route(host)],
    hooks: [
      hook(GenerationTask, {
        // Pi upstream: @earendil-works/pi-durable@1.4.0 — patched transactional beforeInput hook.
        beforeInput: (_input, api) => openQuestionsNote(api.tx, api.conversationId, Date.now()),
        onYield: async (_answer, api, ctx) => {
          const by = (await api.snapshot(Started, api.conversationId, ctx))?.by
          if (by === undefined) return undefined
          await host.harness().commit(async (tx) => {
            // One observer per generation, decided in the commit that creates it.
            const started = await tx.doc(Started, api.conversationId)
            if (started.yielded !== undefined && started.yielded >= api.taskId) return
            started.yielded = api.taskId
            await tx.createTask(
              route(host),
              {
                generation: api.taskId as TaskId<GenerationResult>,
                inputs: [...((await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? [])],
                by,
              },
              {
                ownership: { kind: 'conversation' },
                conversationId: api.conversationId,
                background: true,
              },
            )
          }, ctx)
          return undefined
        },
      }),
    ],
    sections: [
      section('messages', async (input, ctx) => {
        if (!input.agent.tools.some((tool) => tool.name === 'message')) return undefined
        const parent = await parentOf(host, input.conversationId, ctx)
        if (parent !== undefined)
          return `Use message only to update #${parent}, the conversation that started you, while you work; your final answer reaches it anyway. One-way updates (reply: false) reach #${parent} as notes it reads with its next input; ask with reply: true when you need its answer to continue.`
        const agents = await host.need(SubagentsApi).residents(ctx)
        return `Use message to contact #id or @name. Only @ultimate messages user; send it updates with reply: false to relay. Messages wake their recipient; its answer returns as a reply and wakes you. End your turn instead of waiting. A one-way message (reply: false) gets no answer; use reply: true when you need one. Inputs identify their sender; answer here and your answer is sent to the sender automatically; do not use message to reply.\n${agents.map((a) => `@${a.name} — ${a.description}`).join('\n')}`
      }),
    ],
    tools: [
      defineTool({
        name: 'branch',
        deferred: true,
        description: 'Start a lineage branch. Its answer returns to you as a reply.',
        parameters: Type.Object({
          prompt: Type.String({ minLength: 1 }),
          root: Type.Optional(Type.Number()),
          isolated: Type.Optional(Type.Boolean()),
          images: Type.Optional(imagesParameter),
        }),
        // Lineage atomically deduplicates the fork; Sent deduplicates its first message.
        replay: 'safe',
        async execute(input, api, ctx) {
          const from = await actingAs(host, api.conversationId, ctx)
          let id = await api.memo<number>('branch-id', ctx)
          if (id === undefined) {
            const lineage = host.need(LineageApi)
            const roots =
              (await host.harness().snapshot(Roots, ROOT_CONVERSATION_ID, ctx))?.roots ?? []
            const root =
              input.root ??
              (await lineage.rootOf(api.conversationId, ctx)) ??
              (roots.length === 1 ? roots[0] : undefined)
            if (root === undefined || !roots.includes(root))
              throw new Error(
                `Choose a root. Roots: ${roots.map((candidate) => `#${candidate}`).join(', ') || '(none)'}`,
              )
            const { definitions } = await discoverAgents(
              host.ultimateRoot,
              host.projectRoot,
              host.userHome,
              host.modelRuntime,
            )
            const coordinator = definitions.find((definition) => definition.name === 'coordinator')
            if (!coordinator) throw new Error('Missing coordinator definition')
            const branch = await lineage.branch(
              {
                from: root,
                prompt: input.prompt,
                isolated: input.isolated ?? true,
                deliver: false,
                by: from,
                receipt: { taskId: api.taskId, callId: api.callId },
              },
              ctx,
            )
            // The fork has no input yet. Only instructions change: its model and tools stay inherited.
            await host.harness().commit(async (tx) => {
              await configure(tx, branch.id, { instructions: coordinator.instructions })
              ;(await tx.doc(host.metadata, branch.id)).label = 'coordinator'
              ;(await tx.doc(Started, branch.id)).by = from
            }, ctx)
            id = await api.memo('branch-id', branch.id, ctx)
          }
          const message = await send(
            host,
            from,
            {
              to: `#${id}`,
              text: input.prompt,
              reply: true,
              ...(input.images === undefined ? {} : { images: input.images }),
              imagesFrom: api.conversationId,
            },
            ctx,
            api.taskId,
            api.callId,
          )
          if (from !== api.conversationId)
            await host
              .need(LineageApi)
              .leaveNote(
                from,
                `Side chat #${api.conversationId} started branch #${id}: ${input.prompt.split('\n')[0].slice(0, 160)}`,
                {
                  from: api.conversationId,
                  requestId: `sidechat:branch:${api.taskId}:${api.callId}`,
                },
              )
          return {
            output: [{ type: 'text', text: `Branch #${id} started; message ${message} sent.` }],
          }
        },
      }),
      defineTool({
        name: 'message',
        description:
          'Send a message to #id or @name (only @ultimate may send to user). Returns immediately; the answer comes back as a reply. A busy recipient gets it after its current run, or during it with steer: true (the default for @ultimate).',
        parameters: Type.Object({
          to: Type.String(),
          text: Type.String({ minLength: 1 }),
          reply: Type.Optional(Type.Boolean()),
          steer: Type.Optional(Type.Boolean()),
          images: Type.Optional(imagesParameter),
        }),
        // The task-scoped receipt deduplicates admission; the memo returns the same id on replay.
        replay: 'safe',
        async execute(input, api, ctx) {
          // A temporary copy cannot use main's privilege to message the user.
          const from =
            input.to === 'user' ? api.conversationId : await actingAs(host, api.conversationId, ctx)
          const id =
            (await api.memo<number>('message-id', ctx)) ??
            (await api.memo(
              'message-id',
              await send(
                host,
                from,
                { ...input, imagesFrom: api.conversationId },
                ctx,
                api.taskId,
                api.callId,
              ),
              ctx,
            ))
          if (from !== api.conversationId && input.reply !== false) {
            const sent = (await host
              .harness()
              .snapshot(Messages, ROOT_CONVERSATION_ID, ctx))!.messages.find(
              (message) => message.id === id,
            )!
            await host
              .need(LineageApi)
              .leaveNote(
                from,
                `Side chat #${api.conversationId} messaged #${sent.to} (reply comes here): ${input.text.split('\n')[0].slice(0, 160)}`,
                {
                  from: api.conversationId,
                  requestId: `sidechat:message:${api.taskId}:${api.callId}`,
                },
              )
          }
          if (input.to !== 'user')
            return { output: [{ type: 'text', text: `Message ${id} sent.` }] }
          // The message is @ultimate's answer: the run ends here instead of restating it, unless a reply is owed.
          const owed = await host
            .harness()
            .commit(
              async (tx) =>
                (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
                  (m) =>
                    m.to === api.conversationId &&
                    m.reply &&
                    (m.state === 'sent' || m.state === 'delivered'),
                ),
              ctx,
            )
          return {
            output: [{ type: 'text', text: `Message ${id} sent.` }],
            ...(owed ? {} : { control: { terminate: true as const } }),
          }
        },
      }),
    ],
  })
}
