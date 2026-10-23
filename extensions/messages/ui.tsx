/**
 * Messages for other extensions' browser code: its document and asked event, what waits on the user's answer, the
 * pieces a message card is drawn from, and the point where an optional extension adds to a message (its answer card).
 */
export {
  conversationState,
  emptyMessages,
  isOpen,
  relativeTime,
  stateTone,
  stateWord,
  waitingOnUser,
} from './data.tsx'
export type { ConversationState } from './data.tsx'
export { Asked, MessagesDoc, MessageSent } from './refs.ts'
export { accentOf } from './accent.tsx'
export { Address } from './cards.tsx'
export { MessageAnswers } from './points.tsx'
