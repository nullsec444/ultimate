import type { EntryRecord } from '@earendil-works/pi-durable'
import type { MessagesData, Message, Remote } from './refs.ts'

/** How another project's Ultimate is named; the server says the same in its model text. */
export const remoteLabel = (remote: Pick<Remote, 'project' | 'machine'>) =>
  `@ultimate@${remote.project} on ${remote.machine}`

/** Whether tool call `call` ended in an error, from its stored result. */
export const callFailed = (entries: readonly EntryRecord[], call: string) =>
  entries.some((entry) => {
    const message = entry.model?.[0]
    return message?.role === 'toolResult' && message.toolCallId === call && message.isError
  })

/** Only incoming requests belong to an answer, never the outgoing reply log item. */
export function answeredMessages(messages: Message[], conversation: number, entry: number) {
  return messages.filter((message) => message.to === conversation && message.answer === entry)
}

export const emptyMessages: MessagesData = { messages: [], next: 1 }
/** What waits on the user: each question to the user they have neither answered nor dismissed. */
export const waitingOnUser = (log: MessagesData) =>
  log.messages.filter(
    (message) => message.to === 'user' && message.reply && message.state === 'delivered',
  ).length

/**
 * Where a conversation stands, the one state every view shows:
 * - `paused`: the host is paused and its run is parked: no task of it executes until Play;
 * - `working`: it runs, or has input queued;
 * - `waits`: the primary agent (@ultimate) has a question open with the user, the only
 *   state that asks the user to act;
 * - `awaiting`: a conversation that is no subagent asked the primary agent (a branch asking @ultimate) and waits for
 *   the answer; a subagent's questions go to its parent, which answers them in its own run;
 * - `done`: a subagent answered, and its answer went to its parent;
 * - `failed`: its latest input ended without an answer;
 * - `idle`: everything else.
 */
export type ConversationState =
  | 'paused'
  | 'working'
  | 'waits'
  | 'awaiting'
  | 'done'
  | 'failed'
  | 'idle'

export function conversationState(
  conversation: {
    id: number
    /** `primary`: the agent that talks to the user; `subagent`: owned by a task of its parent. */
    kind: 'primary' | 'subagent' | 'other'
    runState?: 'working' | 'queued' | 'idle' | 'answered' | 'error'
    busy?: boolean
    /** A pause of the host parked its run (the `ParkedRuns` point). */
    parked?: boolean
    /** The primary agent's conversation, which a branch's open question waits on. */
    primary?: number
  },
  log: MessagesData,
): ConversationState {
  const { id, kind, runState } = conversation
  if (conversation.parked) return 'paused'
  if (conversation.busy || runState === 'working' || runState === 'queued') return 'working'
  if (kind === 'primary' && waitingOnUser(log) > 0) return 'waits'
  if (
    kind !== 'subagent' &&
    log.messages.some(
      (message) => message.from === id && message.to === conversation.primary && isOpen(message),
    )
  )
    return 'awaiting'
  if (runState === 'error') return 'failed'
  if (kind === 'subagent' && runState === 'answered') return 'done'
  return 'idle'
}

/** A state in the sidebar's and System's lower-case words; `waiting` counts what waits on you. */
export function stateWord(state: ConversationState, waiting = 0) {
  if (state === 'waits') return waiting > 0 ? `${waiting} waiting on you` : 'waits on you'
  return state === 'awaiting' ? 'awaiting @ultimate' : state
}

/** The text colour each state is said in; working's comes from its phase, idle is quiet. */
export const stateTone: Partial<Record<ConversationState, string>> = {
  paused: 'text-warning',
  working: 'text-brand',
  waits: 'text-amber-700 dark:text-amber-300',
  awaiting: 'text-amber-700/80 dark:text-amber-300/70',
  done: 'text-success',
  failed: 'text-error',
}

type Conversation = {
  label?: string
  title?: string
  parentConversationId?: number
  ownerTaskId?: number
}
/** The primary standing agent's conversation, which uses compact mode with the user: @ultimate's. */
export const ultimateCompact = (conversation: Conversation) =>
  conversation.label === 'agent' &&
  conversation.title === '@ultimate' &&
  conversation.parentConversationId === undefined &&
  conversation.ownerTaskId === undefined

/**
 * The messages to you that tool call `call` sent, itself or through a script's nested calls, in the order sent (the log
 * keeps id order). Messages from before the log recorded calls match nothing.
 */
export const sentBy = (messages: readonly Message[], call: string) =>
  messages.filter(
    (message) =>
      message.to === 'user' &&
      message.call !== undefined &&
      (message.call === call || message.call.startsWith(`${call}/`)),
  )

/** Whether a `codemode` call messaged you, from the log alone: a script interrupted before its result counts too. */
export const scriptMessaged = (
  call: { id: string; name: string },
  log: Readonly<MessagesData> | null | undefined,
) => call.name === 'codemode' && sentBy(log?.messages ?? [], call.id).length > 0

/** Entries that render nothing in compact mode: they join a background group without counting in it. */
const hiddenKinds = new Set([
  'board.wake',
  'board.open',
  'setup.note',
  'questions.asked',
  'questions.answers',
])
/** Entries between agents that are background to the user's conversation with @ultimate. */
const backgroundKinds = new Set([
  'lineage.note',
  'lineage.finished',
  'lineage.abstract',
  'lineage.woken',
  'subagents.report',
  'subagents.instruction',
  'workspaces.lander-report',
])

/**
 * Whether a row of @ultimate's compact transcript is background, the traffic between agents that folds into groups: messages and
 * replies from other conversations, notes, reports and landings, branches it starts, messages it sends them, and the
 * answers that went back to them. What the user says and what @ultimate says to the user is the conversation itself; so is any
 * kind not named here, so nothing new hides by default.
 */
export function backgroundRow(
  {
    entry,
    calls,
  }: { entry: EntryRecord; calls: readonly { id: string; name: string; arguments: unknown }[] },
  log: Readonly<MessagesData> | null | undefined,
): boolean | 'hidden' {
  if (hiddenKinds.has(entry.kind)) return 'hidden'
  if (landed(entry)) return false
  if (backgroundKinds.has(entry.kind)) return true
  if (entry.kind === 'board.message' || entry.kind === 'board.reply')
    return (entry.data as { from?: unknown } | undefined)?.from !== 'user'
  const message = entry.model?.[0]
  if (entry.kind !== 'pi.assistant' || message?.role !== 'assistant') return false
  if (calls.length)
    return calls.every(
      (call) =>
        call.name === 'branch' ||
        (call.name === 'message' &&
          (call.arguments as { to?: unknown } | undefined)?.to !== 'user'),
    )
  if (message.stopReason !== 'stop') return false
  const answered = answeredMessages(log?.messages ?? [], entry.conversationId, entry.id)
  return answered.length > 0 && answered.every((m) => m.reply && m.from !== 'user')
}

const idOf = (value: unknown): (number | 'remote')[] =>
  typeof value === 'number' || value === 'remote' ? [value] : []

/**
 * Whether an entry says work landed: the lander's landing note, or its report of a landing. Landings are news you wait
 * for, so they stay in the compact transcript and split background around them; a failed report stays background.
 */
function landed(entry: EntryRecord) {
  const data = entry.data as { source?: unknown; outcome?: { outcome?: unknown } } | undefined
  if (entry.kind === 'lineage.note') return data?.source === 'lander'
  return entry.kind === 'workspaces.lander-report' && data?.outcome?.outcome === 'landed'
}

/** Who a background row is with: the conversations it came from or went to, `lander` for the lander. */
export function counterparts(
  {
    entry,
    calls,
  }: { entry: EntryRecord; calls: readonly { id: string; name: string; arguments: unknown }[] },
  log: Readonly<MessagesData>,
): (number | 'remote' | 'lander')[] {
  const data = (entry.data ?? {}) as {
    from?: unknown
    sender?: unknown
    conversation?: unknown
    source?: unknown
  }
  switch (entry.kind) {
    case 'board.message':
    case 'board.reply':
    case 'lineage.finished':
      return idOf(data.from)
    case 'lineage.note':
      return data.source === 'lander' ? ['lander'] : idOf(data.from)
    case 'lineage.abstract':
      return idOf(data.conversation)
    case 'subagents.report':
    case 'subagents.instruction':
      return idOf(data.sender)
    case 'workspaces.lander-report':
      return ['lander']
  }
  if (calls.length)
    return calls.flatMap((call) => {
      const sent = log.messages.find((m) => m.call === call.id)
      if (sent) return idOf(sent.to)
      const to = /^#(\d+)$/.exec(String((call.arguments as { to?: unknown } | undefined)?.to))
      return to ? [Number(to[1])] : []
    })
  return answeredMessages(log.messages, entry.conversationId, entry.id).flatMap((m) => idOf(m.from))
}

/** The user's answer to a question they were asked, once it has one. */
export const answerTo = (messages: readonly Message[], question: Message) =>
  messages.find((m) => m.from === 'user' && m.re === question.id)

/** A reply-enabled message still waiting for its answer. */
export const isOpen = (message: Message) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

/** Who waits on whom for one message; `yours` is an open question to the user. */
export function messageStatus(message: Message) {
  if (message.state === 'failed') return 'failed'
  if (message.state === 'answered') return 'answered'
  if (message.state === 'dismissed') return 'dismissed'
  if (isOpen(message)) return message.to === 'user' ? 'yours' : 'waiting'
  if (message.state === 'sent') return 'sending'
  return message.re === undefined ? 'one-way' : 'reply'
}

/**
 * A message in its sender's transcript: its status while the log holds it, `sending` while the call runs, and nothing once the
 * call is done and the bounded log has dropped it.
 */
export const sentStatus = (message: Message | undefined, running: boolean) =>
  message ? messageStatus(message) : running ? 'sending' : undefined

/** Where an outgoing message stands, in the sender's words; nothing once the log has dropped a sent one. */
export function outgoingState(message: Message | undefined, toUser: boolean, running: boolean) {
  if (!message) return running ? 'sending' : undefined
  if (message.state === 'failed') return 'failed'
  if (message.state === 'answered') return 'answered'
  if (message.state === 'dismissed') return 'dismissed'
  if (message.state === 'sent') return 'sending'
  if (!message.reply) return 'delivered'
  return toUser ? 'awaiting your reply' : 'awaiting reply'
}

export function relativeTime(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`
}
