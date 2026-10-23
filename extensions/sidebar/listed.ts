/**
 * The top-level conversations the sidebar lists as rows, roots or branches. A side chat (label `side-chat`) is a
 * temporary copy of @ultimate: its fork origin is no branch, so it never shows in In flight, Earlier or Concluded; the
 * side-chat extension nests it under @ultimate instead. Browser-safe.
 */
export const topLevelRows = <T extends { parentConversationId?: number; label?: string }>(
  conversations: readonly T[],
) =>
  conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined && conversation.label !== 'side-chat',
  )
