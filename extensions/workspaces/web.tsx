import { ChevronRightIcon } from 'lucide-react'
import { MentionText } from '@/components/ai/message'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { defineWebExtension, useTranscript } from '@/sdk'
import { CommitCount, LandingCard, useGithubRepo } from './landing.tsx'
import { LanderAskEntry, LanderLogEntry, LanderReport, WorkspaceCall } from './log.tsx'
import { compareUrl } from '../../lib/compare.ts'
import type { EntryRecord } from '@earendil-works/pi-durable'

/** The lander's note in the root: the landing's card, from the note's own data, with the state it froze. */
function LandingNote({ entry }: { entry: EntryRecord }) {
  const {
    from,
    at,
    divergence,
    sha,
    base,
    target,
    title,
    summary,
    feature,
    commits,
    paths,
    more,
    pushed,
    abstract,
  } = entry.data as {
    from: number
    at?: number
    divergence?: string
    sha: string
    base?: string
    target: string
    title?: string
    summary?: string
    feature?: string
    commits: { sha: string; subject: string }[]
    paths: string[]
    more: number
    pushed?: string
    abstract?: { at: number; text: string }
  }
  const github = useGithubRepo()
  // A note from before landings recorded their base: the landing before it, where the lander's serial queue left the
  // target.
  const transcript = useTranscript()
  const previous = base
    ? undefined
    : (
        transcript.findLast(
          (other) =>
            other.kind === 'lineage.note' &&
            other.id < entry.id &&
            (other.data as { source?: string })?.source === 'lander',
        )?.data as { sha?: string } | undefined
      )?.sha
  const rangeBase = base ?? previous
  return (
    <div data-lineage-note="lander">
      <LandingCard
        card={entry.id}
        sha={sha}
        from={from}
        sourceEntry={at}
        divergence={divergence}
        headline={
          <span className="flex flex-wrap items-center gap-x-2">
            <span>
              Landed {sha.slice(0, 7)} on {target}
              {pushed ? ` · pushed to ${pushed}` : ''}
            </span>
            <CommitCount
              className="text-muted-foreground"
              count={commits.length + more}
              href={github && rangeBase ? compareUrl(github, rangeBase, sha) : undefined}
              range={rangeBase ? `${rangeBase}...${sha}` : undefined}
            />
          </span>
        }
        subject={{
          ...(title ? { title } : {}),
          ...(summary ? { summary } : {}),
          ...(feature ? { feature } : {}),
        }}
        tone="landed"
      >
        {paths.length > 0 && (
          <p className="break-words text-muted-foreground">Changed: {paths.join(', ')}</p>
        )}
        {abstract && (
          <Collapsible className="group/state">
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/state:rotate-90" />
              State at landing
              <span className="text-muted-foreground/70">
                · #{from}/{abstract.at}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-1 pl-4 font-sans text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
              <MentionText text={abstract.text} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </LandingCard>
    </div>
  )
}

export default defineWebExtension({
  tools: { workspace: WorkspaceCall },
  entries: {
    'lineage.note': ({ entry, core }) =>
      (entry.data as { source?: string })?.source === 'lander' ? (
        <LandingNote entry={entry} />
      ) : (
        core
      ),
    'ultimate.lander': LanderLogEntry,
    'ultimate.lander-ask': LanderAskEntry,
    'workspaces.lander-report': LanderReport,
  },
})
