import {
  BrainIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitForkIcon,
  ScrollTextIcon,
  StickyNoteIcon,
  SunriseIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MentionText, MessageResponse } from '@/components/ai/message'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  defineWebExtension,
  events,
  errorMessage,
  Fold,
  provide,
  Provided,
  formatTime,
  formatTokens,
  useConversation,
  useDocOf,
  useExtensionUiState,
  useNow,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { store } from '@/sdk/client'
import { ConversationRef, Unsummarized } from '../conversations/ui.tsx'
import { talkToUltimate } from '../subagents/ui.tsx'
import { Open } from '../workspaces/ui.tsx'
import { CompactAction, ForgetAction, MemoryDoc, TallyDoc } from './refs.ts'
import type { MemoryItem } from './refs.ts'
import { column, EmptyRoot, MEMORY_PANEL, useRoots } from './ui.tsx'
import { GoBackAction, Rewound, RewoundDependent } from './rewind.tsx'

function userText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** A branch started from this conversation: in its tree's root a card with its intent, elsewhere a quiet divider. */
function Branched({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, intent } = entry.data as { branch: number; intent: string }
  if (entry.model) return <Started entry={entry} />
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-foreground"
      data-lineage-branched={branch}
      onClick={() => switchConversation(branch)}
      title={`Open #${branch}`}
      type="button"
    >
      <span className="flex max-w-[70%] min-w-0 items-center gap-1.5">
        <GitForkIcon className="size-3 shrink-0" />
        <span className="shrink-0">Branched →</span>
        <ConversationRef id={branch} title={intent} />
      </span>
    </button>
  )
}

/** The wake-up after a manual compaction of @ultimate: a quiet divider, not a user bubble. */
function Woken() {
  return (
    <div
      className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70"
      data-lineage-woken
    >
      <span className="flex items-center gap-1.5">
        <SunriseIcon className="size-3 shrink-0" />
        woke after compaction
      </span>
    </div>
  )
}

/** The tally's branch node: which branch started, from where, with what intent (older nodes carry the whole prompt). */
function Started({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, at, intent, images, from } = entry.data as {
    branch: number
    at: number
    intent: string
    images?: number
    from?: number
  }
  const [open, setOpen] = useState(false)
  const timestamp = entry.model?.[0]?.timestamp
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20"
      data-lineage-started={branch}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <GitForkIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-foreground">Started</span>
        <button
          className="flex min-w-0 cursor-pointer overflow-hidden text-foreground hover:underline"
          onClick={() => switchConversation(branch)}
          title={`Open #${branch}`}
          type="button"
        >
          <ConversationRef id={branch} />
        </button>
        {from !== undefined && (
          <button
            className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
            onClick={() => switchConversation(from)}
            title={`Open #${from}`}
            type="button"
          >
            from #{from}/{at}
          </button>
        )}
        {timestamp !== undefined && (
          <time
            className="ml-auto shrink-0 tabular-nums"
            dateTime={new Date(timestamp).toISOString()}
            title={new Date(timestamp).toLocaleString()}
          >
            {formatTime(new Date(timestamp))}
          </time>
        )}
      </header>
      <button
        aria-expanded={open}
        className="block w-full min-w-0 cursor-pointer px-3 py-2.5 text-left text-[13px] leading-relaxed"
        onClick={() => setOpen((current) => !current)}
        title={open ? 'Show less' : 'Show more'}
        type="button"
      >
        <span className={cn('block break-words whitespace-pre-wrap', !open && 'line-clamp-3')}>
          <MentionText text={intent} />
        </span>
        {!!images && (
          <span className="mt-1.5 block font-mono text-[11px] text-muted-foreground">
            {images} image{images === 1 ? '' : 's'}
          </span>
        )}
      </button>
    </section>
  )
}

type AbstractData = {
  conversation: number
  at: number
  text: string
  title?: string
  anchor?: number
}

/**
 * A conversation's abstract at its anchor, with the text of the newest carrier that replaced it; carriers show nothing.
 * Once a landing froze it (or, in older tallies, a later abstract superseded it), it is not shown.
 */
function Abstract({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const transcript = useTranscript()
  if ((entry.data as AbstractData).anchor !== undefined) return null
  let latest = entry
  for (const other of transcript)
    if (other.id > latest.id && other.edits?.some((edit) => edit.target === entry.id))
      latest = other
  const omitted = latest.edits?.some((edit) => edit.target === entry.id && edit.action === 'omit')
  if (omitted) return null
  const { conversation, at, text, title } = latest.data as AbstractData
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <ScrollTextIcon className="size-3 shrink-0" />
          <span className="shrink-0">Abstract</span>
          <span className="flex min-w-0 text-foreground/80">
            <ConversationRef id={conversation} title={title} />
          </span>
        </>
      }
    >
      <section
        className="min-w-0 rounded-md border border-border bg-muted/20"
        data-lineage-abstract={conversation}
      >
        <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <ScrollTextIcon className="size-3.5 shrink-0" />
          <span className="shrink-0">Abstract ·</span>
          <button
            className="flex min-w-0 cursor-pointer text-foreground hover:underline"
            onClick={() => switchConversation(conversation)}
            title={`Open #${conversation}`}
            type="button"
          >
            <ConversationRef id={conversation} title={title} />
          </button>
          <Open className="ml-auto" entry={at} id={conversation} />
        </header>
        <p className="min-w-0 px-3 py-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          <MentionText text={text} />
        </p>
      </section>
    </Fold>
  )
}

/** A conversation this one asked `notify` about has finished: its title and last answer. */
function Finished({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { from, title, text } = entry.data as { from: number; title?: string; text: string }
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <CircleCheckIcon className="size-3 shrink-0 text-success" />
          <span className="flex min-w-0 text-foreground/80">
            <ConversationRef id={from} title={title} />
          </span>
          <span className="shrink-0">finished</span>
        </>
      }
    >
      <section
        className="min-w-0 rounded-md border border-l-2 border-border border-l-success/70 bg-muted/20"
        data-lineage-finished={from}
      >
        <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <CircleCheckIcon className="size-3.5 shrink-0 text-success" />
          <button
            className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-foreground hover:underline"
            onClick={() => switchConversation(from)}
            title={`Open #${from}`}
            type="button"
          >
            <ConversationRef id={from} title={title} />
            <span className="shrink-0">finished</span>
          </button>
        </header>
        <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
          <MessageResponse>{text}</MessageResponse>
        </div>
      </section>
    </Fold>
  )
}

/** A note between conversations, tinted yellow: as received (`Note from #N`) and as left (`Note → #N`). */
function NoteCard({
  label,
  id,
  text,
  note,
}: {
  label: string
  id?: number | string
  text: string
  note: 'received' | 'left'
}) {
  const { switchConversation } = useUltimate()
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-note/25 border-l-note/60 bg-note/6"
      data-lineage-note={note}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-note/15 px-3 py-2 font-mono text-[11px] text-foreground">
        <StickyNoteIcon className="size-3.5 shrink-0 text-note" />
        {label}
        {typeof id === 'number' ? (
          <button
            className="min-w-0 cursor-pointer hover:underline"
            onClick={() => switchConversation(id)}
            title={`Open #${id}`}
            type="button"
          >
            <ConversationRef id={id} />
          </button>
        ) : (
          id
        )}
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

/** A note another conversation (or the lander, a quiet `notify`, a catch-up on the tally and main) left here. */
function Note({ entry, core }: { entry: EntryRecord; core: React.ReactNode }) {
  const { from, text, source } = entry.data as {
    from?: number
    text: string
    source?: 'lander' | 'finished' | 'main'
  }
  if (source === 'lander') return core
  if (source === 'finished') return <Finished entry={entry} />
  if (source !== 'main')
    return (
      <Fold
        card={entry.id}
        summary={
          <>
            <StickyNoteIcon className="size-3 shrink-0 text-note" />
            <span className="shrink-0">Note from</span>
            {from !== undefined && (
              <span className="flex min-w-0 text-foreground/80">
                <ConversationRef id={from} />
              </span>
            )}
          </>
        }
      >
        <NoteCard id={from} label="Note from" note="received" text={text} />
      </Fold>
    )
  return (
    <Fold
      card={entry.id}
      summary={
        <>
          <GitBranchIcon className="size-3 shrink-0 text-brand" />
          <span className="shrink-0">Catch-up</span>
        </>
      }
    >
      <section
        className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20"
        data-lineage-note="main"
      >
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-foreground">
          <GitBranchIcon className="size-3.5 text-brand" />
          Catch-up
        </header>
        <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
          <MessageResponse>{text}</MessageResponse>
        </div>
      </section>
    </Fold>
  )
}

/** The `note` tool as the note it left; a failed call keeps the generic card with its error. */
function NoteCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  if (call.status === 'error' || call.status === 'interrupted') return core
  const left = /^Left a note in #(\d+)\.$/.exec(call.output)
  const to = left ? Number(left[1]) : call.args.to
  return (
    <NoteCard
      id={typeof to === 'number' ? to : typeof to === 'string' ? to : undefined}
      label="Note →"
      note="left"
      text={typeof call.args.text === 'string' ? call.args.text : ''}
    />
  )
}

/** A conversation's history distilled into the start of its tally. */
function Genesis({ entry }: { entry: EntryRecord }) {
  const text = userText(entry)
  const from = /^<tally from="#(\d+)\/(\d+)">/.exec(text)
  const source = from ? Number(from[1]) : undefined
  const genesis = text.replace(/^<tally[^>]*>\n/, '').replace(/\n<\/tally>$/, '')
  return (
    <Collapsible
      className="group/genesis rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-genesis={entry.conversationId}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/genesis:rotate-90" />
          Context starts here{from ? ` · distilled from #${from[1]}/${from[2]}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          {source !== undefined && source !== entry.conversationId
            ? 'The project reading is distilled into the start of this context.'
            : 'The conversation before this point is distilled into the start of the context. Earlier messages remain available above.'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        {from && <Open id={Number(from[1])} entry={Number(from[2])} />}
        <MessageResponse>{genesis}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A tally's genesis, or the empty reset a new tally starts with, which shows nothing. */
function Reset({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const roots = useRoots()
  const lineage = (entry.data as { lineage?: { tally?: true } } | undefined)?.lineage
  if (lineage?.tally) return <Genesis entry={entry} />
  if (!entry.model && entry.data === undefined && roots?.includes(entry.conversationId)) return null
  return core
}

/** A root takes no input: an empty one starts by getting familiar with the project, any other shows its tally footer. */
function RootComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const roots = useRoots()
  if (id === undefined || !roots?.includes(id)) return core
  return <TallyComposer dock={dock} id={id} key={id} />
}

/** Only a root subscribes to its `lineage.tally` document; a root from before tallies has none and shows the footer. */
function TallyComposer({ id, dock }: { id: number; dock?: boolean }) {
  const tally = useDocOf(id, TallyDoc)
  const history = useConversation((conversation) =>
    conversation.loading ? undefined : conversation.entries.length > 0,
  )
  if (tally === undefined || history === undefined) return null
  if (tally?.since === undefined && !history)
    return (
      <Provided input={{ id, dock }} point={EmptyRoot}>
        {(start) => start}
      </Provided>
    )
  return <TallyFooter brief={tally?.briefTokens} dock={dock} id={id} tokens={tally?.tokens} />
}

/**
 * In place of a tally's composer: what a new branch starts from and its size (the memory brief, or the whole context
 * while there are no memories), and the way to @ultimate, who keeps it.
 */
function TallyFooter({
  id,
  tokens,
  brief,
  dock,
}: {
  id: number
  tokens?: number
  brief?: number
  dock?: boolean
}) {
  const actions = useUltimate()
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div
        className="rounded-lg border border-border bg-muted/20 px-3.5 py-2.5"
        data-lineage-tally-footer={id}
      >
        <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <ScrollTextIcon className="size-3.5 shrink-0 text-brand" />
          <span className="shrink-0 text-foreground">
            {brief === undefined ? 'Context' : 'Memory'}
          </span>
          {(brief ?? tokens) !== undefined && (
            <span className="shrink-0" data-lineage-tokens={brief ?? tokens}>
              · {formatTokens((brief ?? tokens)!)} tokens
            </span>
          )}
          {tokens !== undefined && (
            <button
              className="ml-auto shrink-0 cursor-pointer hover:text-foreground hover:underline"
              onClick={() => void api.action(CompactAction, { id })}
              title="Have @ultimate reshape this history into a shorter one; nothing is deleted"
              type="button"
            >
              Compact
            </button>
          )}
          <button
            className={cn(
              'shrink-0 cursor-pointer text-brand hover:underline',
              tokens === undefined && 'ml-auto',
            )}
            onClick={() => void talkToUltimate(actions)}
            type="button"
          >
            Talk to @ultimate
          </button>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          {brief === undefined
            ? 'What every new branch starts from until there are memories. @ultimate maintains it.'
            : 'What every new branch starts from. The context above is the browsable history; @ultimate maintains both.'}
        </p>
        <Memory id={id} />
      </div>
    </div>
  )
}

const kindTones: Record<MemoryItem['kind'], string> = {
  decision: 'bg-brand/10 text-brand',
  fact: 'bg-muted text-muted-foreground',
  lesson: 'bg-note/15 text-amber-700 dark:text-note',
}

/** How long ago `at` was, in the sidebar's short form: now, 5m, 3h, 2d, then a date. */
function age(at: number, now: number) {
  const minutes = Math.max(0, (now - at) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / 60 / 24)}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Where a memory was learned, `#conversation/entry`, as that conversation's chip; a click opens it at the entry. */
function MemorySource({ source }: { source: string }) {
  const { switchConversation, showSurface } = useUltimate()
  const [conversation, entry] = source.slice(1).split('/').map(Number)
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground/70">
      <span className="shrink-0">learned in</span>
      <button
        className="flex min-w-0 cursor-pointer items-center rounded-sm px-0.5 text-[11px] text-foreground hover:bg-accent"
        data-memory-source={source}
        onClick={() => {
          if (entry !== undefined) events.emit('messages:open', { conversation, entry })
          showSurface('agent')
          switchConversation(conversation)
        }}
        title={`Open ${source}`}
        type="button"
      >
        <ConversationRef className="gap-1" id={conversation} />
        {entry !== undefined && <span className="shrink-0 text-muted-foreground/70">/{entry}</span>}
      </button>
    </p>
  )
}

/** A root's project memory, folded to `Memory · N`, newest first; nothing while it has none. */
function Memory({ id }: { id: number }) {
  const memories = useDocOf(id, MemoryDoc)?.memories
  const [unfolded, setUnfolded] = useExtensionUiState<number[]>('memoryOpen', [])
  const now = useNow(60_000)
  const open = unfolded.includes(id)
  const slugs = Object.keys(memories ?? {}).toSorted(
    (a, b) => memories![b].updated - memories![a].updated || a.localeCompare(b),
  )
  if (!memories || !slugs.length) return null
  return (
    <section className="mt-2 border-t border-border/60 pt-1.5" data-lineage-memory={id}>
      <button
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 font-mono text-[9.5px] tracking-wider text-muted-foreground/70 uppercase outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() =>
          setUnfolded((previous) => [
            ...previous.filter((root) => root !== id),
            ...(open ? [] : [id]),
          ])
        }
        type="button"
      >
        {slugs.length} {slugs.length === 1 ? 'memory' : 'memories'}
        <ChevronRightIcon className={cn('size-2.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <ul className="-mx-1.5 mt-1 flex max-h-[45vh] flex-col overflow-y-auto">
          {slugs.map((slug) => (
            <MemoryRow item={memories[slug]} key={slug} now={now} root={id} slug={slug} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** One memory: its kind, slug, line and age; a click shows its body and source. The trash icon forgets it. */
function MemoryRow({
  root,
  slug,
  item,
  now,
  plain,
}: {
  root: number
  slug: string
  item: MemoryItem
  now: number
  /** Under a heading that already names its kind: no kind chip. */
  plain?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  return (
    <li className="group/memory min-w-0 rounded-sm hover:bg-muted/40" data-memory={slug}>
      <div className="flex min-w-0 items-start">
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 px-1.5 py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setOpen((current) => !current)}
          title={open ? 'Show less' : 'Show the memory'}
          type="button"
        >
          <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
            {!plain && (
              <span className={cn('shrink-0 rounded-sm px-1', kindTones[item.kind])}>
                {item.kind}
              </span>
            )}
            <span className="min-w-0 truncate text-foreground/80">{slug}</span>
            <span
              className="ml-auto shrink-0 pl-1 text-muted-foreground/60"
              title={new Date(item.updated).toLocaleString()}
            >
              {age(item.updated, now)}
            </span>
          </span>
          <span
            className={cn(
              'block text-[12px] leading-snug break-words text-foreground/85',
              !open && 'truncate',
            )}
          >
            {item.line}
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={`Forget ${slug}`}
              className="invisible mt-0.5 mr-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 outline-none group-focus-within/memory:visible group-hover/memory:visible pointer-coarse:visible hover:bg-muted hover:text-error focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              disabled={forgetting}
              onClick={() => {
                setForgetting(true)
                void api
                  .action(ForgetAction, { root, slug })
                  .catch((error: unknown) =>
                    store.notify({ level: 'error', message: errorMessage(error) }),
                  )
                  .finally(() => setForgetting(false))
              }}
              type="button"
            >
              <Trash2Icon className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="font-mono text-[11px]" side="left">
            Forget this memory
          </TooltipContent>
        </Tooltip>
      </div>
      {open && (
        <div className="min-w-0 px-1.5 pb-2">
          <div className="min-w-0 text-[12.5px] leading-relaxed text-muted-foreground">
            <MessageResponse>{item.body}</MessageResponse>
          </div>
          {item.source && <MemorySource source={item.source} />}
        </div>
      )}
    </li>
  )
}

const kindSections = [
  ['decision', 'Decisions'],
  ['fact', 'Facts'],
  ['lesson', 'Lessons'],
] as const

/**
 * The Memory panel: each root's project memory, what every new branch starts from, grouped into decisions, facts and
 * lessons, newest first. A row unfolds its body and source; @ultimate maintains it.
 */
function MemoryPanel() {
  const roots = useRoots() ?? []
  return (
    <div className="flex flex-col pb-4" data-lineage-memory-panel>
      {roots.map((root) => (
        <RootMemory key={root} label={roots.length > 1} root={root} />
      ))}
    </div>
  )
}

function RootMemory({ root, label }: { root: number; label: boolean }) {
  const memories = useDocOf(root, MemoryDoc)?.memories ?? {}
  const now = useNow(60_000)
  const slugs = Object.keys(memories).toSorted(
    (a, b) => memories[b].updated - memories[a].updated || a.localeCompare(b),
  )
  return (
    <section className="px-3" data-lineage-memory={root}>
      {label && <p className="pt-3 font-mono text-[11px] text-foreground">#{root}</p>}
      {slugs.length === 0 ? (
        <p className="py-6 text-xs text-muted-foreground">
          No memories yet. @ultimate keeps decisions, facts and lessons here as branches land.
        </p>
      ) : (
        kindSections.map(([kind, title]) => {
          const shown = slugs.filter((slug) => memories[slug].kind === kind)
          if (!shown.length) return null
          return (
            <div className="mt-3" data-memory-kind={kind} key={kind}>
              <h3 className="flex items-center gap-1.5 pb-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
                <span className={cn('size-1.5 rounded-full', kindDots[kind])} />
                {title}
                <span className="text-muted-foreground/60">{shown.length}</span>
              </h3>
              <ul className="-mx-1.5 flex flex-col">
                {shown.map((slug) => (
                  <MemoryRow
                    item={memories[slug]}
                    key={slug}
                    now={now}
                    plain
                    root={root}
                    slug={slug}
                  />
                ))}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}

const kindDots: Record<MemoryItem['kind'], string> = {
  decision: 'bg-brand',
  fact: 'bg-muted-foreground/60',
  lesson: 'bg-amber-500',
}

/** Keeps the roots streaming for synchronous readers, such as the `when` of the agent's Compact command. */
function Roots() {
  useRoots()
  return null
}

export default defineWebExtension({
  tools: { note: NoteCall },
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'lineage.woken': Woken,
    'lineage.abstract': Abstract,
    'lineage.rewound': Rewound,
    'lineage.rewound-dependent': RewoundDependent,
    'pi.reset': Reset,
  },
  messageActions: [GoBackAction],
  composer: RootComposer,
  panels: [
    { id: MEMORY_PANEL, title: 'Memory', icon: BrainIcon, component: MemoryPanel, order: 6 },
  ],
  slots: { overlay: [Roots] },
  // A root runs no turns and gets no summaries: its tally speaks for it.
  provides: [provide(Unsummarized, (id) => useRoots()?.includes(id) ?? false)],
})
