import { cn, Provided } from '@/sdk'
import { stateTone, stateWord } from '../messages/ui.tsx'
import type { ConversationState } from '../messages/ui.tsx'
import type { useWorkspaceIndex } from '../workspaces/ui.tsx'
import { ConversationPhase } from '../conversations/ui.tsx'

/** `now`, `5m`, `3h`, `2d`, then a short date. */
export function ago(at: number, now: number) {
  const minutes = Math.max(0, (now - at) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / 60 / 24)}d`
  const date = new Date(at)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', year: '2-digit' },
  )
}

/**
 * The lander's line: "fixing" or "diagnosing" while its model works on a failure, a pulsing "landing" while it lands,
 * its working phase (or "working") while it answers someone, else its conversation state (failed, awaiting, idle); then
 * how many submissions wait in its queue and when it last landed. What landed is its Landed section's first row.
 */
export function LanderState(props: LanderProps) {
  return (
    <Provided input={props.state === 'working' ? props.id : undefined} point={ConversationPhase}>
      {(phase) => <PhasedLanderState {...props} phase={phase?.word} />}
    </Provided>
  )
}
type LanderProps = {
  id: number
  index: ReturnType<typeof useWorkspaceIndex>
  now: number
  state: ConversationState
}

function PhasedLanderState({ id, index, now, state, phase }: LanderProps & { phase?: string }) {
  const source = Object.entries(index.landerConversations).find(([, lander]) => lander === id)?.[0]
  const current = index.queue.find((item) => item.source === source && item.state === 'landing')
  const queued = index.queue.filter(
    (item) => item.source === source && item.state === 'queued',
  ).length
  const label =
    current?.agent === 'fix'
      ? 'fixing'
      : current?.agent
        ? 'diagnosing'
        : current
          ? 'landing'
          : state === 'working'
            ? (phase ?? 'working')
            : undefined
  const last = Object.values(index.results).findLast((result) => result.lander === id && result.sha)
  const at = last?.steps.at(-1)?.at
  return (
    <>
      {label === undefined ? (
        <span className={cn('shrink-0', stateTone[state])}>{stateWord(state)}</span>
      ) : (
        <span
          className={cn(
            'shrink-0',
            label === 'fixing'
              ? 'text-amber-700 dark:text-amber-300'
              : label !== 'diagnosing' && 'text-brand',
          )}
        >
          {label}
        </span>
      )}
      {queued > 0 && <span className="shrink-0 text-foreground/80">queue {queued}</span>}
      {at !== undefined && (
        <span
          className="ml-auto shrink-0 text-muted-foreground/80"
          title={new Date(at).toLocaleString()}
        >
          {ago(at, now)}
        </span>
      )}
    </>
  )
}
