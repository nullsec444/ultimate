import type { MessageQuestionsData } from './types.ts'

type Doc = Readonly<MessageQuestionsData> | null | undefined
/** The fields of a message the answer card reads. */
export type Message = {
  id: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  reply: boolean
  state: string
}

/** Whether a message to the user still waits on their answer or dismissal. */
export const waitsOnUser = (message: Message) =>
  message.to === 'user' && message.reply && message.state === 'delivered'

/** The questions of a message while it still waits on the user's reply; none once it is answered or dismissed. */
export function openQuestions(log: Doc, message: Message) {
  return waitsOnUser(message) ? (log?.asked[String(message.id)] ?? []) : []
}

/** Every message that waits on the user, newest first. */
export const waiting = <M extends Message>(messages: readonly M[]) =>
  messages.filter(waitsOnUser).toReversed()

/** The newest message showing an answer card: only it takes the desktop 1–9 and Enter keys. */
export function newestAsked(log: Doc, messages: readonly Message[]) {
  return messages.findLast((message) => openQuestions(log, message).length > 0)?.id
}

/** The card taking desktop keys on a conversation's page: its newest open message with an answer card. */
export const keyCard = (
  log: Doc,
  conversation: number | undefined,
  messages: readonly Message[],
) => {
  const id = newestAsked(
    log,
    messages.filter((message) => message.from === conversation),
  )
  return id === undefined ? undefined : `message:${id}`
}
