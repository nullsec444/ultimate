import type { EntryRecord } from '@earendil-works/pi-durable'

/** The stored response that made tool call `call`: going back from a message it sent returns there. */
export const callerOf = (entries: readonly EntryRecord[], call: string) =>
  entries.findLast((entry) => {
    const message = entry.model?.[0]
    return (
      message?.role === 'assistant' &&
      message.content.some((block) => block.type === 'toolCall' && block.id === call)
    )
  })
