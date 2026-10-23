/**
 * Conversations: titles, summaries, the summary model and concluding conversations. Other extensions read what a
 * conversation is about and ask the summary model through this service.
 */
import type { Context } from '@earendil-works/chord'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { ConversationSubject, KeptWork } from './types.ts'
import type { accountResponse, askSummaryModel, SummaryRequest } from './summary.ts'
import type { SummaryModel, SummaryModelStatus } from './summary-model.ts'

export type ConversationsService = {
  /** What conversation `id` is about now: its title, summary and feature, for a record that outlives a retitle. */
  subject: (id: ConversationId, caller: Context) => Promise<ConversationSubject>
  /** The conversations the user concluded; use it to leave their resources (worktrees) alone or free them. */
  concluded: (caller: Context) => Promise<Set<ConversationId>>
  /** Read concluded conversations inside an existing transaction, including its pending changes. */
  concludedIn(tx: Tx): Promise<Set<ConversationId>>
  /**
   * Conclude top-level conversations `ids` inside `tx`, as the Conclude action does before it frees their resources
   * through `Release`; throws for unknown and owned conversations, roots and standing agents.
   */
  concludeIn(tx: Tx, ids: ConversationId[]): Promise<void>
  /** The summary model to ask now, from settings; undefined while none is valid and available. */
  summaryModel(): Promise<SummaryModel | undefined>
  /** The summary model with why: the configured one, a fallback for a default without a login, or why none runs. */
  summaryModelStatus(): Promise<SummaryModelStatus>
  /** Request a summary of `id` inside the trigger's transaction, with the model resolved before it. */
  requestSummary(
    tx: Tx,
    id: ConversationId,
    request: SummaryRequest,
    model: SummaryModel | undefined,
  ): Promise<void>
  /** Ask a summary model once with a system prompt and input, or return the response the receipt already holds. */
  askSummaryModel: typeof askSummaryModel
  /** Add a summary model response's usage to the conversation's `pi.usage` inside `tx`, after asking. */
  accountResponse: typeof accountResponse
  /**
   * Inside `tx`, mark `title` of a new conversation `id` (a branch or root named by its intent) as generated, so its
   * summary may replace it; a no-op once a rename or summary chose another title.
   */
  generatedTitle(tx: Tx, id: ConversationId, title: string): Promise<void>
}
export type TreesService = {
  /** The root of the tree conversation `id` belongs to, or undefined outside any tree. */
  rootOf(id: number, ctx: Context): Promise<number | undefined>
  /** The root whose tally lists top-level conversation `id`, with its branch intent; undefined for roots and others. */
  branchOf(id: number, ctx: Context): Promise<{ root: number; intent?: string } | undefined>
  /**
   * Write the abstract of conversation `id` into its tree root's tally inside `tx`, before the transaction's first
   * entry; a no-op outside a tree.
   */
  abstract(
    tx: Tx,
    id: number,
    input: { text: string; at: number; title?: string; feature?: string },
  ): Promise<void>
}
/**
 * The extension point through which summaries know a conversation's tree: a root's feature names its whole tree, and
 * a branch's summary writes its abstract into the tally. Lineage provides it.
 */
export const Trees = defineApi<TreesService>()('conversations.trees')
export type ReleaseService = {
  /** Free what concluded conversations `ids` and their owned descendants hold; returns the work kept, and why. */
  release(ids: number[], caller: Context): Promise<KeptWork[]>
}
/** The extension point concluding frees resources through; workspaces provides it (worktrees). */
export const Release = defineApi<ReleaseService>()('conversations.release')
/** Conversation subjects and the summary model; core, so `need` it. */
export const ConversationsApi = defineApi<ConversationsService>()('conversations')
export const tier = 'core'
