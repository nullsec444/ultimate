import { GitBranchIcon, ListTreeIcon, MessageSquareIcon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ToolStatusIcon } from '@/components/ai/tool'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  formatDuration,
  provide,
  RunStart,
  useAction,
  useConversation,
  useNow,
  useTasks,
  useUltimate,
  useUiState,
} from '@/sdk'
import type { TaskGraph, TaskGraphNode } from '@/sdk'
import { store } from '@/sdk/client'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import { useWorkspaceConversations as useConversations } from '../workspaces/ui.tsx'
import { FeatureTag, hiddenConversationIds, useOverview } from '../conversations/ui.tsx'
import { RetryAction, StartedAction } from './refs.ts'

interface Tree {
  /** Live tasks by owner task id. */
  children: Map<number, TaskGraphNode[]>
  /** Conversation-owned tasks by conversation id. */
  roots: Map<number, TaskGraphNode[]>
  summaries: Map<number, ConversationSummary>
  /** Tool names of the shown conversation's tool tasks. */
  tools: Map<number, string>
  /** When each task first ran, in wall-clock milliseconds. */
  started: Record<string, number>
  /** Feature tags of top-level conversations. */
  features: Map<number, string>
  now: number
}

function build(
  graph: TaskGraph | undefined,
  conversations: readonly ConversationSummary[],
  concluded: number[],
) {
  const hidden = hiddenConversationIds(conversations, concluded)
  const all = Object.values(graph?.tasks ?? {}).toSorted((a, b) => a.id - b.id)
  const hiddenTasks = new Set(
    all.filter((task) => hidden.has(task.conversationId)).map((task) => task.id),
  )
  let changed = true
  while (changed) {
    changed = false
    // Task ownership can arrive before the child's summary; child runs have no task owner.
    for (const task of all) {
      if (hidden.has(task.conversationId) || (task.owner != null && hiddenTasks.has(task.owner))) {
        if (!hiddenTasks.has(task.id)) {
          hiddenTasks.add(task.id)
          changed = true
        }
        for (const id of task.conversations) {
          if (!hidden.has(id)) {
            hidden.add(id)
            changed = true
          }
        }
      }
    }
    for (const conversation of conversations) {
      if (
        conversation.parentConversationId !== undefined &&
        hidden.has(conversation.parentConversationId) &&
        !hidden.has(conversation.id)
      ) {
        hidden.add(conversation.id)
        changed = true
      }
    }
  }
  const tasks = all
    .filter((task) => !hiddenTasks.has(task.id))
    .map((task) => ({
      ...task,
      conversations: task.conversations.filter((id) => !hidden.has(id)),
    }))
  const children = new Map<number, TaskGraphNode[]>()
  const roots = new Map<number, TaskGraphNode[]>()
  for (const task of tasks) {
    const [map, key] = task.owner == null ? [roots, task.conversationId] : [children, task.owner]
    map.set(key, [...(map.get(key) ?? []), task])
  }
  // Conversations a live task owns appear under that task; the rest are top-level.
  const owned = new Set<number>(tasks.flatMap((task) => task.conversations))
  const top = [...roots.keys()].filter((id) => !owned.has(id)).toSorted((a, b) => a - b)
  return {
    tasks,
    top,
    children,
    roots,
    summaries: new Map(conversations.map((summary) => [summary.id, summary])),
  }
}

function status(task: TaskGraphNode): {
  text: ReactNode
  tone?: string
  icon: 'running' | 'pending' | 'done' | 'interrupted'
} {
  const { state } = task
  if (task.blocked)
    return {
      text:
        task.blocked === 'restart_limit'
          ? 'parked after 5 crashes'
          : `blocked · ${task.blocked.replaceAll('_', ' ')}`,
      icon: 'interrupted',
      tone: 'text-warning',
    }
  switch (state.status) {
    case 'pending':
      return { text: 'pending', icon: 'pending' }
    case 'running':
      return { text: state.phase, icon: 'running', tone: 'text-foreground/80' }
    case 'waiting':
      return {
        text: (
          <>
            {state.phase} · waiting on{' '}
            <span className="text-foreground/70">{state.on.map((id) => `#${id}`).join(' ')}</span>
            {state.on.length > 1 && (
              <span className="text-muted-foreground/60"> ({state.policy})</span>
            )}
          </>
        ),
        icon: 'pending',
      }
    case 'sleeping':
      return { text: `${state.phase} · sleeping`, icon: 'pending' }
    default:
      return {
        text: `completing → ${state.outcome}`,
        icon: state.outcome === 'completed' ? 'done' : 'interrupted',
      }
  }
}

export function TaskRow({ task, tree, depth }: { task: TaskGraphNode; tree: Tree; depth: number }) {
  const { text, tone, icon } = status(task)
  const kind = task.kind.replace(/^pi\./, '')
  const tool = tree.tools.get(task.id)
  return (
    <>
      <div
        className="flex min-w-0 items-center gap-1.5 py-1.5 pr-3 font-mono text-[11.5px]"
        style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
      >
        <ToolStatusIcon className="size-3" state={icon} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground/90">{tool ?? kind}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground/60">
            <span className="shrink-0">#{task.id}</span>
            <span className={cn('truncate', tone)}>{text}</span>
          </span>
        </span>
        {task.blocked === 'restart_limit' && <RetryButton id={task.id} />}
        {task.background && (
          <span className="shrink-0 rounded-sm border border-border/80 px-1 text-[10px] text-muted-foreground">
            bg
          </span>
        )}
        {tree.started[task.id] !== undefined && !task.blocked && (
          <span
            className={cn(
              'shrink-0 text-[10.5px] tabular-nums',
              tree.now - tree.started[task.id] >= 10 * 60_000
                ? 'text-warning'
                : 'text-muted-foreground/70',
            )}
            title={`Running since ${new Date(tree.started[task.id]).toLocaleString()}`}
          >
            {formatDuration(tree.now - tree.started[task.id])}
          </span>
        )}
        {task.abortRequested && (
          <span className="shrink-0 text-[10.5px] text-warning">aborting</span>
        )}
      </div>
      {(tree.children.get(task.id) ?? []).map((child) => (
        <TaskRow depth={depth + 1} key={child.id} task={child} tree={tree} />
      ))}
      {task.conversations.map((id) => (
        <ConversationRow depth={depth + 1} id={id} key={`c${id}`} tree={tree} />
      ))}
    </>
  )
}

/** Runs a parked task again; the crash-loop guard parks it once more if it keeps crashing the process. */
export function RetryButton({ id }: { id: number }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="flex shrink-0 items-center gap-1 rounded-sm border border-border/80 px-1.5 py-0.5 font-sans text-[11px] text-foreground/85 transition-colors hover:bg-accent disabled:opacity-50"
      data-retry={id}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await api.action(RetryAction, { id })
        } catch (error) {
          store.notify({ level: 'error', message: errorMessage(error) })
        } finally {
          setBusy(false)
        }
      }}
      title="Run this task again"
      type="button"
    >
      <RotateCcwIcon className="size-3" />
      Retry
    </button>
  )
}

function ConversationRow({ id, tree, depth }: { id: number; tree: Tree; depth: number }) {
  const { conversationId, switchConversation } = useUltimate()
  const summary = tree.summaries.get(id)
  const shown = conversationId === id
  return (
    <>
      <button
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 py-1.5 pr-3 text-left font-mono text-[11.5px] transition-colors hover:bg-accent/50',
          shown && 'bg-accent/60',
        )}
        onClick={() => switchConversation(id)}
        style={{ paddingLeft: `${0.75 + depth * 0.9}rem` }}
        title={shown ? 'Shown' : 'Show this conversation'}
        type="button"
      >
        <MessageSquareIcon
          className={cn('size-3 shrink-0', shown ? 'text-brand' : 'text-muted-foreground')}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate font-sans text-[12px] text-foreground/90"
              title={summary?.title}
            >
              {summary?.title || summary?.label || 'Untitled conversation'}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground/60">
            {tree.features.get(id) && <FeatureTag feature={tree.features.get(id)!} />}
            <span className="shrink-0">#{id}</span>
            {summary?.workspace && (
              <GitBranchIcon
                aria-label="Isolated checkout"
                className="size-3 shrink-0 text-muted-foreground"
              />
            )}
          </span>
        </span>
      </button>
      {(tree.roots.get(id) ?? []).map((task) => (
        <TaskRow depth={depth + 1} key={task.id} task={task} tree={tree} />
      ))}
    </>
  )
}

function TasksPanel() {
  const graph = useTasks()
  const conversations = useConversations()
  const { live } = useConversation()
  const [concluded] = useUiState<number[]>('ext.conversations.concluded', [])
  const { tasks, top, ...rest } = build(graph, conversations, concluded)
  const overview = useOverview()
  const now = useNow(1000, tasks.length > 0)
  // A start time never changes, so only tasks without one yet are asked for.
  const [started, setStarted] = useState<Record<string, number>>({})
  const missing = tasks.map((task) => task.id).filter((id) => !(id in started))
  const { data } = useAction(StartedAction, { ids: missing }, { enabled: missing.length > 0 })
  useEffect(() => {
    if (data) setStarted((previous) => ({ ...previous, ...data }))
  }, [data])
  const tree: Tree = {
    ...rest,
    started,
    now,
    features: new Map(
      Object.entries(overview).flatMap(([id, row]) =>
        row.feature ? [[Number(id), row.feature]] : [],
      ),
    ),
    tools: new Map(
      (live.tools ?? []).flatMap((slot) =>
        slot.taskId === undefined ? [] : [[slot.taskId, slot.name]],
      ),
    ),
  }
  const running = tasks.filter((task) => task.state.status === 'running' && !task.blocked).length
  const parked = tasks.filter((task) => task.blocked === 'restart_limit').length
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Task graph
        <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
          {tasks.length} live{running > 0 && ` · ${running} running`}
          {parked > 0 && <span className="text-warning"> · {parked} parked</span>}
        </span>
      </div>
      {top.map((id) => (
        <ConversationRow depth={0} id={id} key={id} tree={tree} />
      ))}
      {tasks.length === 0 && (
        <div className="px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
          idle · no live tasks
        </div>
      )}
    </div>
  )
}

/** When run task `id` first ran, asked once per run, for the transcript's working clock. */
function useRunStart(id: number | undefined): number | undefined {
  const { data } = useAction(
    StartedAction,
    { ids: id === undefined ? [] : [id] },
    {
      enabled: id !== undefined,
    },
  )
  return id === undefined ? undefined : data?.[id]
}

export default defineWebExtension({
  provides: [provide(RunStart, useRunStart)],
  panels: [{ id: 'tasks', title: 'Tasks', icon: ListTreeIcon, component: TasksPanel, order: -5 }],
  commands: [
    {
      id: 'tasks.open',
      title: 'Show the task graph',
      run: (context) => context.openPanel('tasks'),
    },
  ],
})
