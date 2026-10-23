import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, ParkedRuns, Provided, useDocOf, useStore, useTasks, useUltimate } from '@/sdk'
import { MessagesDoc, emptyMessages, waitingOnUser } from '../messages/ui.tsx'
import { AgentMark, ConversationPhase, useOverview } from '../conversations/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import { primaryLabel } from './label.ts'

/** Renders with how many questions wait on the user's answer or dismissal. */
export function WaitingOnUser({ children }: { children: (waiting: number) => ReactNode }) {
  return children(waitingOnUser(useDocOf(1, MessagesDoc) ?? emptyMessages))
}

/** A busy standing agent's word: its classified phase, lower case like its idle line, else "working". */
const workingWord = (phase: { word: string; waiting: boolean } | undefined) =>
  phase && !phase.waiting ? phase.word : 'working'

/** A busy standing agent's line in the sidebar: its working word in the brand colour. */
export function StandingPhase({ id }: { id: number }) {
  return (
    <Provided input={id} point={ConversationPhase}>
      {(phase) => <span className="shrink-0 text-brand">{workingWord(phase)}</span>}
    </Provided>
  )
}

/** The title bar's way to @ultimate from every surface, with its state and the questions that wait on you. */
export function UltimateButton() {
  return (
    <Provided input={null} point={ParkedRuns}>
      {(parked) => <Primary parked={parked} />}
    </Provided>
  )
}

const name = 'ultimate'

function Primary({ parked }: { parked?: ReadonlySet<number> }) {
  const actions = useUltimate()
  const id = useDocOf(1, StandingDoc)?.[name]
  const tasks = useTasks()
  const runState = useOverview()[id ?? -1]?.runState
  const shown = useStore((state) => state.view?.conversation.id ?? state.requested)
  const paused = id !== undefined && parked?.has(id) === true
  const working =
    id !== undefined &&
    !paused &&
    (runState === 'working' ||
      Object.values(tasks?.tasks ?? {}).some(
        (task) => !task.background && task.conversationId === id,
      ))
  const active = id !== undefined && shown === id && actions.surface === 'agent'
  return (
    <WaitingOnUser>
      {(waiting) => (
        <Provided input={working ? id : undefined} point={ConversationPhase}>
          {(phase) => {
            const word = workingWord(phase)
            const label = primaryLabel({ paused, working, word, waiting })
            return (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-current={active ? 'page' : undefined}
                      aria-label={`Talk to @${name} (${label})`}
                      className={cn(
                        'flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                        active && 'text-foreground',
                      )}
                      data-ultimate-button
                      onClick={() => void talkToUltimate(actions)}
                      type="button"
                    >
                      <AgentMark
                        name={name}
                        presence={working ? 'working' : waiting ? 'waiting' : undefined}
                        size="sm"
                      />
                      @{name}
                      {working && word !== 'working' && <span className="text-brand">{word}</span>}
                      {paused && <span className="text-warning">paused</span>}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Talk to @{name} · {label}
                  </TooltipContent>
                </Tooltip>
                {waiting > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={`${waiting} ${waiting === 1 ? 'question waits' : 'questions wait'} on you`}
                        className="-ml-1 flex h-5 shrink-0 items-center rounded-sm bg-amber-500/15 px-1.5 text-amber-700 transition-colors outline-none hover:bg-amber-500/25 focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-300"
                        data-questions-count
                        onClick={() => actions.openPanel('todos')}
                        type="button"
                      >
                        {waiting}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{waiting} waiting on you · open Questions</TooltipContent>
                  </Tooltip>
                )}
              </>
            )
          }}
        </Provided>
      )}
    </WaitingOnUser>
  )
}
