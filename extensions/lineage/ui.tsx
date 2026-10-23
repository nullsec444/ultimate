/**
 * Lineage for other extensions' browser code: the project's roots, a root's tally, landing links and compaction, the
 * branch and root events, and the point where an empty root shows how to start (onboarding's Start here card).
 */
import type { ReactNode } from 'react'
import { definePoint, getState, useDocOf } from '@/sdk'
import { RootsDoc } from './refs.ts'

export {
  Branched,
  CompactAction,
  MemoryDoc,
  RecentAction,
  Rooted,
  RootsDoc,
  TallyDoc,
} from './refs.ts'
export type { MemoryItem } from './refs.ts'

/** The id of lineage's Memory panel: every root's project memory, grouped by kind. */
export const MEMORY_PANEL = 'memory'

/** The composer's reading column, as the core lays it out; a card in place of a root's composer uses it. */
export const column = (dock?: boolean) =>
  dock ? 'w-full px-4' : 'mx-auto w-full max-w-[46rem] px-3 sm:px-6'

/** What an empty root shows in place of its composer (`onboarding` provides the Start here card); `dock` is narrow. */
export const EmptyRoot = definePoint<{ id: number; dock?: boolean }, ReactNode>(
  'lineage.empty-root',
)

/** Conversation 1 keeps the `lineage.roots` document. */
const keeper = 1

/** The project's roots, live in every client; undefined until the stream delivers them. */
export function useRoots() {
  return useDocOf(keeper, RootsDoc)?.roots
}

/** The roots as last streamed, for synchronous readers such as a command's `when`; a mounted `useRoots` keeps them. */
export function getRoots() {
  return (getState().docsOf[keeper]?.[RootsDoc.kind] as { roots: number[] } | null | undefined)
    ?.roots
}
