import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Branch } from '../lineage/api.ts'
import { Messages } from '../messages/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'

const Seen = defineDoc<{ key?: string }>({
  kind: 'watchdog.seen',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({}),
})

export async function idleNote(
  tx: Tx,
  host: ExtensionHost,
  conversationId: ConversationId,
  now: number,
) {
  const concluded = await host.need(ConversationsApi).concludedIn(tx)
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  const excluded = new Set([...concluded, ...queue.map((item) => item.conversationId)])
  const messages = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages
  for (const message of messages)
    if (
      typeof message.from === 'number' &&
      message.to === 'user' &&
      message.reply &&
      message.state === 'delivered'
    )
      excluded.add(message.from)
  const conversations = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanConversations({}, 500, cursor)
    conversations.push(...page.items)
    cursor = page.next
  } while (cursor)
  // Owned descendants keep their branch working even when its coordinator is between turns.
  const children = new Map<ConversationId, ConversationId[]>()
  for (const conversation of conversations) {
    if (!conversation.owner) continue
    const owner = conversation.owner.conversationId
    const siblings = children.get(owner) ?? []
    siblings.push(conversation.id)
    children.set(owner, siblings)
  }
  const working = async (id: ConversationId): Promise<boolean> => {
    if ((await tx.doc(LiveDoc, id)).run) return true
    for (const child of children.get(id) ?? []) if (await working(child)) return true
    return false
  }
  const idle = []
  // Branches are ownerless, so subagents are skipped before any document read: this runs before every @ultimate input.
  for (const conversation of conversations) {
    if (conversation.owner || excluded.has(conversation.id)) continue
    if (!(await tx.doc(Branch, conversation.id)).branch) continue
    const metadata = await tx.doc(host.metadata, conversation.id)
    const age =
      now -
      Math.max(
        metadata.inputAt ?? metadata.answerAt ?? now,
        metadata.answerAt ?? metadata.inputAt ?? now,
      )
    if (age <= 2 * 60 * 60 * 1000 || (await working(conversation.id))) continue
    idle.push({
      id: conversation.id,
      title: metadata.title ?? 'Untitled',
      hours: Math.floor(age / 3_600_000),
    })
  }
  const key = idle.map((branch) => branch.id).join(',')
  const seen = await tx.doc(Seen, conversationId)
  if ((seen.key ?? '') === key) return undefined
  seen.key = key
  const content = idle.length
    ? [
        'Open branches idle for more than 2 h; check on each or conclude it:',
        ...idle
          .slice(0, 10)
          .map((branch) => `- #${branch.id} ${branch.title} (idle ${branch.hours}h)`),
        ...(idle.length > 10 ? [`and ${idle.length - 10} more`] : []),
      ].join('\n')
    : 'No branches are idle.'
  return {
    entries: [
      {
        kind: 'watchdog.idle',
        data: { ids: idle.map((branch) => branch.id), text: content },
        model: [{ role: 'user' as const, content, timestamp: now }],
      },
    ],
  }
}
