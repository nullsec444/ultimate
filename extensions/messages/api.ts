/**
 * Messages: messages between conversations and the user, delivered as inputs or notes. Other extensions send one-way
 * messages and answer the user's open questions here.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc } from '@earendil-works/pi-durable'
import type { EntryId } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Device } from '../../shared/events.ts'
import { MessagesDoc } from './refs.ts'
import type { Remote, Triage } from './refs.ts'

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
  entry?: EntryId
  answer?: EntryId
  error?: string
  /** The tool call that sent it: `message`'s or `branch`'s own id, `<script>/<n>` for a nested codemode call. */
  call?: string
  /** Images forwarded with it: the sender's entry that holds them, attached to the recipient's input on delivery. */
  images?: { entry: EntryId; count: number }
  /** Whether a message to the primary agent woke it: assessing, then act or fyi with a one-line reason. */
  triage?: Triage
  /** The other project's Ultimate a `remote` side names. */
  remote?: Remote
}
/** Every message between conversations and the user, on the root conversation. */
export const Messages = defineDoc<{ messages: Message[]; next: number }>({
  kind: MessagesDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: [], next: 1 }),
})

export type MessagesService = {
  /**
   * Reply `text` from the user to open message `messageId`, from browser `device`; returns the reply's message
   * id. Records a `user.input` event.
   */
  answer(messageId: number, text: string, ctx: Context, device?: Device): Promise<number>
  /** Close open message `messageId` unanswered; its sender gets a one-way note. Returns the note's message id. */
  dismiss(messageId: number, ctx: Context, device?: Device): Promise<number>
  /** Send a one-way message from conversation `from` to `to` (`#id`, `@name` or `user`), once per `requestId`. */
  send(
    from: number,
    input: { to: string; text: string; reply: false },
    requestId: string,
    ctx: Context,
  ): Promise<number>
  /**
   * From the primary agent's conversation `from`, message another project's primary agent (on `machine`, else where it
   * runs): only that Ultimate receives it. With `reply`, its answer returns here as a reply. Returns this log's id of the
   * message and the target's id of the delivered one; throws a sentence naming the machine when it cannot be reached.
   */
  tell(
    from: number,
    input: { project: string; machine?: string; text: string; reply?: boolean },
    ctx: Context,
    signal?: AbortSignal,
  ): Promise<{ message: number; delivered: number }>
}
export { Asked, MessageSent, Triaged } from './refs.ts'
/** Messages between conversations; core, so `need` it. */
export const MessagesApi = defineApi<MessagesService>()('messages')

/** What gates the model calls Messages makes inside its tasks; an optional extension (pause) fills it. */
export type GateService = {
  /**
   * Run `work`, a model call of task `task` in conversation `conversationId` described by `what`: start it only once
   * nothing holds such work (it waits meanwhile, until `signal` aborts), and count it as in flight while it runs.
   */
  work<T>(
    call: { task: number; conversationId: number; what: string },
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>
}
/** Messages’ gate for in-task model calls, an extension point; `want` it: without a provider, work runs at once. */
export const Gate = defineApi<GateService>()('messages.gate')
export const tier = 'core'
