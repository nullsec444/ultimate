import { CompassIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { api, cn, errorMessage, touchKeyboard, useDocOf, useSystem, useUltimate } from '@/sdk'
import { column } from '../lineage/ui.tsx'
import { StartAction, StartsDoc } from './refs.ts'

/**
 * An empty root starts with @ultimate's setup and reading, toward optional instructions; what it learns becomes the
 * project memory every branch starts from.
 */
export function Familiarize({ id, dock }: { id: number; dock?: boolean }) {
  const project = useSystem()?.project.name
  const ui = useUltimate()
  const started = useDocOf(1, StartsDoc)?.roots[String(id)]
  const [focus, setFocus] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const begin = async () => {
    if (sending) return
    setSending(true)
    setError(undefined)
    try {
      const result = await api.action(StartAction, {
        root: id,
        ...(focus.trim() ? { instructions: focus } : {}),
      })
      ui.switchConversation(result.id)
      ui.showSurface('agent')
    } catch (failure) {
      setError(errorMessage(failure))
      setSending(false)
    }
  }
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div
        className="rounded-lg border border-brand/30 bg-brand/5 px-4 py-3.5"
        data-lineage-familiarize={id}
      >
        <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-[0.25em] text-brand uppercase">
          <CompassIcon className="size-3.5" />
          Start here
        </div>
        {started === undefined && (
          <>
            <p className="mt-2 text-[15px] font-medium text-foreground">
              Let Ultimate get familiar with {project ?? 'the project'}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Talk to @ultimate to choose your setup and read the project. It writes what it learned
              into this root's context, which every branch starts from.
            </p>
            <textarea
              aria-label="Focus"
              autoFocus={!touchKeyboard()}
              className="mt-3 field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-brand/50"
              disabled={sending}
              onChange={(event) => setFocus(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                if (touchKeyboard()) return
                event.preventDefault()
                // oxlint-disable-next-line typescript/no-floating-promises -- begin catches setup failures and displays them with setError.
                void begin()
              }}
              placeholder="Optional instructions: what this tree is for and how to read, e.g. focus on the API, also look through past conversations…"
              value={focus}
            />
          </>
        )}
        <div className="mt-2.5 flex items-center gap-3">
          {error ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-error">{error}</span>
          ) : started === undefined ? (
            <span className="hidden font-mono text-[11px] whitespace-nowrap text-muted-foreground/70 sm:inline pointer-coarse:hidden">
              <Kbd>↵</Kbd> start · <Kbd>⇧↵</Kbd> new line
            </span>
          ) : null}
          {started !== undefined ? (
            <p className="text-xs text-muted-foreground">
              @ultimate is setting up this project ·{' '}
              <button
                className="text-brand hover:underline"
                onClick={() => {
                  ui.switchConversation(started)
                  ui.showSurface('agent')
                }}
                type="button"
              >
                open
              </button>
            </p>
          ) : (
            <Button className="ml-auto" disabled={sending} onClick={() => void begin()} size="sm">
              {sending ? (
                <LoaderCircleIcon className="motion-safe:animate-spin" />
              ) : (
                <CompassIcon />
              )}
              Set up with @ultimate
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
