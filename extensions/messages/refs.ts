/**
 * Messages in the browser: every message between conversations and the user, which the sidebar, the message cards
 * and the sounds read, and the event of a question to the user. Browser-safe.
 * Stored identifiers keep the board prefix because history, tasks and events persist under them.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/**
 * Another project's Ultimate: its project and machine, and `id`, that instance's id of the same message (the sender's
 * for an incoming one, the target's once an outgoing one is delivered).
 */
export type Remote = {
  project: string
  machine: string
  id?: number
  /** The sender's random key for the message: the target delivers it once, and only the target can reply to it. */
  key: string
}

/** One message as the log stores it. */
export type Message = {
  id: number
  /** `remote`: another project's Ultimate, named by `remote`. */
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  text: string
  at: number
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'dismissed' | 'failed'
  entry?: number
  answer?: number
  error?: string
  /** The tool call that sent it: `message`'s own id, or `<script>/<n>` for a nested codemode call. */
  call?: string
  /** Images forwarded with it: the sender's entry that holds them, attached to the recipient's input on delivery. */
  images?: { entry: number; count: number }
  /** Whether a message to the primary agent woke it: assessing, then act or fyi with a one-line reason. */
  triage?: Triage
  /** The other project's Ultimate a `remote` side names. */
  remote?: Remote
}
/** A triage verdict: `act` wakes the primary agent, `fyi` leaves it as context for its next input. */
export type Triage = { verdict: 'assessing' | 'act' | 'fyi'; reason?: string }
export type MessagesData = { messages: Message[]; next: number }

/** Every message between conversations and the user, oldest first, on conversation 1. */
export const MessagesDoc = docRef<MessagesData>('board')

/**
 * `{ conversation, call }` → `{ entry }`: the response in `conversation`'s history that made tool call `call` (a
 * message's `call`), however old; no `entry` when the history has none.
 */
export const CallerAction = actionRef<{ conversation: number; call: string }, { entry?: number }>(
  'messages',
  'caller',
)

/**
 * Conversation `from` asked the user something: it posted reply-enabled message `message` to the user. Emitted in
 * the posting commit; react to it to work on the question (questions extracts its answer card).
 */
export const Asked = defineEvent<{ message: number; from: number }>('board.asked')

/**
 * Message `message` was posted from `from` to `to`; `reply` whether it waits for an answer, `steer` whether it
 * steers a busy recipient. Never its text. Emitted in the posting commit; answers are no posts.
 */
export const MessageSent = defineEvent<{
  message: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  reply: boolean
  steer: boolean
}>('board.sent')

/**
 * Message `message` from `from` to the primary agent `to` was triaged: `act` woke it, `fyi` left it as context.
 * Emitted in the commit that records the verdict.
 */
export const Triaged = defineEvent<{
  message: number
  from: number | 'remote'
  to: number
  verdict: 'act' | 'fyi'
  reason: string
}>('board.triaged')
