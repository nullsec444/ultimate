import { BlocksIcon, CheckIcon, FolderCogIcon, GitBranchIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  api,
  defineWebExtension,
  errorMessage,
  provide,
  useAction,
  useConversation,
  useDialog,
  useEvent,
  useExtensions,
  useSystem,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FirstRun, GitCard, ProjectCard, Recommended } from './pages.tsx'
import { IsolationAction } from '../workspaces/ui.tsx'
import { EmptyRoot } from '../lineage/ui.tsx'
import { Familiarize } from './survey.tsx'
import { ExtensionsPanel } from './panel.tsx'
import { gitDialog, projectDialog } from './parts.tsx'
import { ChooseAction, HelpAction, StartAction, StatusAction } from './refs.ts'

function useIsolation() {
  const workspaces = useExtensions().some((extension) => extension.name === 'workspaces')
  const isolation = useAction(IsolationAction, null, { enabled: workspaces })
  const busy = useConversation((conversation) => conversation.busy)
  const { refetch } = isolation
  const wasBusy = useRef(busy)
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (wasBusy.current && !busy && workspaces) void refetch()
    wasBusy.current = busy
  }, [busy, refetch, workspaces])
  useEvent('onboarding:git', () => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (workspaces) void refetch()
  })
  return workspaces ? isolation.data : undefined
}

async function askUltimate(card: 'project' | 'git') {
  const { id } = await api.action(HelpAction, { card })
  return id
}

function Onboarding() {
  const status = useAction(StatusAction)
  const ui = useUltimate()
  const [finished, setFinished] = useState(false)
  // Existing panel/start-page entry points now ask @ultimate too; no setup dialogs remain.
  const [projectOpen, setProjectOpen] = useDialog(projectDialog)
  const [gitOpen, setGitOpen] = useDialog(gitDialog)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!projectOpen && !gitOpen) return
    setProjectOpen(false)
    setGitOpen(false)
    void askUltimate(projectOpen ? 'project' : 'git')
      .then((id) => {
        ui.switchConversation(id)
        ui.showSurface('agent')
      })
      .catch((failure) => setError(errorMessage(failure)))
  }, [projectOpen, gitOpen, setProjectOpen, setGitOpen, ui])
  return (
    <>
      <FirstRun
        open={!navigator.webdriver && status.data?.firstRun === true && !finished}
        onClosed={() => ui.focusComposer()}
        onDone={async (skipped) => {
          if (!skipped) {
            const { id } = await api.action(StartAction, {})
            ui.switchConversation(id)
            ui.showSurface('agent')
          }
          setFinished(true)
        }}
      />
      {error && (
        <div
          role="alert"
          className="fixed right-4 bottom-12 rounded border border-error/40 bg-card p-3 text-xs text-error"
          onClick={() => setError(undefined)}
        >
          {error}
        </div>
      )}
    </>
  )
}

function SetupLink({ card, children }: { card: 'project' | 'git'; children: string }) {
  const ui = useUltimate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const click = async () => {
    if (busy) return
    setBusy(true)
    try {
      ui.switchConversation(await askUltimate(card))
      ui.showSurface('agent')
      setError(undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const Icon = card === 'project' ? FolderCogIcon : GitBranchIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          disabled={busy}
          className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void click()}
          type="button"
        >
          <Icon className="size-3 text-brand" />
          {error ?? children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {error ?? 'Ask @ultimate for help with this folder.'}
      </TooltipContent>
    </Tooltip>
  )
}
function Undecided() {
  const project = useSystem()?.project
  return project?.config && project.decision === null ? (
    <SetupLink card="project">project setup</SetupLink>
  ) : null
}
function NoGit() {
  const reason = useIsolation()?.reason
  return reason ? <SetupLink card="git">set up git</SetupLink> : null
}

type Choice = { card: string; summary: string; toolCallId: string }
function SetupCall({ call }: { call: ToolCallView }) {
  const transcript = useTranscript()
  const conversationId = useConversation((conversation) => conversation.id)
  const status = useAction(StatusAction)
  const isolation = useIsolation()
  const card = typeof call.args.card === 'string' ? call.args.card : ''
  const entry = transcript.find(
    (candidate) =>
      candidate.kind === 'onboarding.choice' && (candidate.data as Choice).toolCallId === call.id,
  )
  const settled = (entry?.data as Choice | undefined)?.summary
  const done = async (payload: {
    extensions?: Record<string, boolean>
    local?: boolean
    initialize?: boolean
  }) => {
    await api.action(ChooseAction, { card, ...payload, toolCallId: call.id }, { conversationId })
  }
  if (!['extensions', 'project', 'git'].includes(card)) return null
  const title =
    card === 'extensions'
      ? 'Recommended extensions'
      : card === 'project'
        ? "Use this project's setup?"
        : 'Set up Git for this folder?'
  return (
    <section
      className="overflow-hidden rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
      data-setup-card={card}
    >
      <header className="border-b border-border px-4 py-2.5 font-mono text-xs text-muted-foreground">
        {title}
      </header>
      {call.status === 'error' ? (
        <p className="p-4 text-xs text-error">
          {call.diagnostics.find((item) => item.severity === 'error')?.message ?? call.output}
        </p>
      ) : settled ? (
        <p className="flex items-start gap-2 p-4 text-sm">
          <CheckIcon className="size-4 shrink-0 text-brand" />
          <span>Chosen: {settled}</span>
        </p>
      ) : call.status !== 'done' ? (
        <p className="p-4 text-xs text-muted-foreground">
          {call.status === 'interrupted'
            ? 'Setup was interrupted. Ask @ultimate to show this card again.'
            : 'Checking…'}
        </p>
      ) : card === 'extensions' ? (
        <Recommended status={status.data} onDone={done} />
      ) : card === 'project' ? (
        <ProjectCard adds={status.data?.adds} onDone={done} />
      ) : (
        <GitCard isolation={isolation} onDone={done} />
      )}
    </section>
  )
}
function ChoiceCard({ entry }: { entry: EntryRecord }) {
  const data = entry.data as Choice
  return (
    <section className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <span className="font-mono">Setup choice · {data.card}</span>
      <p className="mt-1 text-foreground/85">{data.summary}</p>
    </section>
  )
}

export default defineWebExtension({
  tools: { setup: SetupCall },
  entries: {
    'onboarding.choice': ChoiceCard,
    'onboarding.start': ({ entry }) => {
      const data = entry.data as { root: number; instructions?: string }
      return (
        <section className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-mono">Onboarding started · root #{data.root}</span>
          {data.instructions && (
            <p className="mt-1 whitespace-pre-wrap text-foreground/85">{data.instructions}</p>
          )}
        </section>
      )
    },
  },
  slots: { overlay: [Onboarding], 'statusline.right': [NoGit, Undecided] },
  provides: [provide(EmptyRoot, ({ id, dock }) => <Familiarize dock={dock} id={id} />)],
  panels: [
    {
      id: 'extensions',
      title: 'Extensions',
      icon: BlocksIcon,
      component: ExtensionsPanel,
      order: 8,
    },
  ],
  commands: [
    {
      id: 'onboarding.extensions',
      title: 'Extensions…',
      run: (context) => context.openPanel('extensions'),
    },
  ],
})
