import { createContext, useEffect } from 'react'
import type { ReactNode } from 'react'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { store } from './client.ts'

export const ConversationIdContext = createContext<number | undefined>(undefined)
/** The entries loaded by the nearest transcript or composer; a new scope resets inherited history. */
export const TranscriptContext = createContext<readonly EntryRecord[] | undefined>(undefined)

/** The DOM marker of a scope: shortcuts typed inside it run with its id as `context.conversationId`. */
export const scopeAttribute = 'data-conversation-scope'

/**
 * Give descendants their own live conversation without switching the shell's shown conversation.
 * Hooks and transcript/composer contributions inherit this id, and so do shortcuts pressed inside it; the palette and
 * the imperative `api` stay global.
 * Scopes of the same id share a stream, released when the last scope unmounts.
 */
export function ConversationScope({ id, children }: { id: number; children: ReactNode }) {
  useEffect(() => store.watchConversation(id), [id])
  return (
    <ConversationIdContext value={id}>
      <TranscriptContext value={undefined}>
        <div className="contents" {...{ [scopeAttribute]: id }}>
          {children}
        </div>
      </TranscriptContext>
    </ConversationIdContext>
  )
}

/** The conversation of the scope `target` is in, if any. */
export function scopeOf(target: EventTarget | null): number | undefined {
  const scope = target instanceof HTMLElement ? target.closest(`[${scopeAttribute}]`) : null
  const id = Number(scope?.getAttribute(scopeAttribute))
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}
