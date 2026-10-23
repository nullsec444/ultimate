/**
 * Subagents: conversations delegated to agent definitions, and the standing agents. Other extensions create
 * configured child conversations and open standing agents here; definitions themselves are read with `lib/agents.ts`.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, TaskId } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { StandingDoc } from './refs.ts'
import type { createChild } from './children.ts'

export { Started } from './refs.ts'

/** Each conversation's subagents and pending subagent actions, on the conversation that started them. */
export const Subagents = defineDoc<{
  agents: Record<
    string,
    {
      conversationId: ConversationId
      agent: string
      background: boolean
      reported: EntryId[]
    }
  >
  actions: Record<
    string,
    {
      conversationId: ConversationId
      reporter: TaskId
      answer?: EntryId
      status?: string
    }
  >
}>({
  kind: 'ultimate.subagents',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {}, actions: {} }),
})

/** `{ [name]: conversationId }` of the standing agents, on the root conversation. */
export const Standing = defineDoc<Record<string, ConversationId>>({
  kind: StandingDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

/** The definition a conversation was configured from: children (including automation runs) and standing agents. */
export const Profile = defineDoc<{ definition?: string }>({
  kind: 'ultimate.agent-profile',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export type SubagentsService = {
  /** The standing agents that run in this home, by name and description; use it to list valid `@name` addresses. */
  residents(ctx: Context): Promise<{ name: string; description: string }[]>
  /** The conversation of standing agent `name`, created or refreshed from its definition; throws for unknown names. */
  standing(name: string, ctx: Context): Promise<ConversationId>
  /** Create, inside `tx`, a child conversation configured from a definition or as a copy of the parent's agent. */
  createChild: typeof createChild
}
/** Child conversations and standing agents; `need` it where delegation is required, else `want` it. */
export const SubagentsApi = defineApi<SubagentsService>()('subagents')
export const tier = 'core'
