import { CheckIcon, MessageCircleQuestionIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api, cn, errorMessage, useConversation, useDocOf, useViewport } from '@/sdk'
import { MessagesDoc } from '../messages/ui.tsx'
import { keyCard, openQuestions } from './open.tsx'
import type { Message } from './open.tsx'
import { AnswerAction, DismissAction, QuestionsDoc } from './refs.ts'
import type { Answer } from './refs.ts'
import type { Question } from './types.ts'
import { answered as ready, choiceForKey, choices, picks, position } from './state.tsx'

/** Whether `card` is the one on the shown conversation's page that takes the desktop 1–9 and Enter keys. */
function useKeys(card: string) {
  const log = useDocOf(1, QuestionsDoc)
  const messages = useDocOf(1, MessagesDoc)?.messages ?? []
  const conversation = useConversation((value) => value.id)
  return keyCard(log, conversation, messages) === card
}

/**
 * The answer card of a message that waits on the user: its extracted questions, or only Dismiss while none were
 * extracted. `keys` (default: the shown conversation decides) whether it takes the desktop 1–9 and Enter keys.
 */
export function MessageQuestions({
  message,
  keys,
  className,
}: {
  message: Message
  keys?: boolean
  className?: string
}) {
  const questions = openQuestions(useDocOf(1, QuestionsDoc), message)
  const card = `message:${message.id}`
  const shown = useKeys(card)
  if (message.to !== 'user' || !message.reply || message.state !== 'delivered') return null
  return (
    <Card
      card={card}
      questions={questions}
      keys={questions.length > 0 && (keys ?? shown)}
      submit={(answers) => api.action(AnswerAction, { messageId: message.id, answers })}
      reply={(text) => api.action(AnswerAction, { messageId: message.id, text })}
      dismiss={() => api.action(DismissAction, { messageId: message.id })}
      {...(className === undefined ? {} : { className })}
    />
  )
}

function Card({
  card,
  questions,
  keys,
  submit,
  reply,
  dismiss,
  className = 'border-t border-border/60',
}: {
  card: string
  questions: Question[]
  keys: boolean
  submit: (answers: Answer[]) => Promise<unknown>
  reply: (text: string) => Promise<unknown>
  dismiss: () => Promise<unknown>
  className?: string
}) {
  const [text, setText] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [custom, setCustom] = useState<Record<number, boolean>>({})
  const [current, setCurrent] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const phone = useViewport() === 'phone'
  const answered = ready(questions, answers)
  const recommended = picks(questions)
  const hasPicks = Object.keys(recommended).length > 0
  const select = (index: number, option: number) => {
    const value = choices(questions[index])[option]
    if (!value) return
    const other = !!value.custom
    setCustom((old) => ({ ...old, [index]: other }))
    setAnswers((old) => ({ ...old, [index]: other ? '' : value.label }))
    setCurrent(index)
  }
  // Every pick at once; questions without one keep what was chosen.
  const accept = () => {
    setCustom((old) => ({
      ...old,
      ...Object.fromEntries(Object.keys(recommended).map((i) => [i, false])),
    }))
    setAnswers((old) => ({ ...old, ...recommended }))
  }
  const run = async (action: () => Promise<unknown>) => {
    if (sending) return
    setSending(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSending(false)
    }
  }
  const send = () => (answered.length ? run(() => submit(answered)) : Promise.resolve())
  useEffect(() => {
    if (!keys || phone || sending) return undefined
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        // Outside this card, another card or a control keeps its own keys.
        (!root.current?.contains(target) && target?.closest('[data-questions-card], button, a'))
      )
        return
      const choice = /^[1-9a-z]$/.test(event.key)
        ? choiceForKey(questions[current], event.key)
        : undefined
      if (choice !== undefined) {
        event.preventDefault()
        select(current, choice)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setCurrent(Math.min(questions.length - 1, Math.max(0, current + step)))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        // Once every question has an answer (after Accept picks, say), Enter sends from anywhere.
        if (current < questions.length - 1 && answered.length < questions.length)
          setCurrent(current + 1)
        // oxlint-disable-next-line typescript/no-floating-promises -- send delegates to run, which catches and displays submission failures.
        else void send()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  // Nothing extracted to answer with buttons: a reply field for this message, and Dismiss.
  if (!questions.length)
    return (
      <form
        className={cn(className, 'flex flex-wrap items-center gap-2 px-3 py-2')}
        data-questions-card={card}
        onSubmit={(event) => {
          event.preventDefault()
          // oxlint-disable-next-line typescript/no-floating-promises -- run catches reply failures and displays them with setError.
          if (text.trim()) void run(() => reply(text.trim()))
        }}
      >
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-brand" />
        <input
          aria-label="Your answer"
          placeholder="Your answer…"
          value={text}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          className="min-h-8 min-w-0 flex-1 basis-40 rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-brand/60"
        />
        <Button
          variant="ghost"
          size="xs"
          type="button"
          disabled={sending}
          onClick={() => void run(dismiss)}
          title="Close it without an answer; the agent gets a note"
        >
          Dismiss
        </Button>
        <Button size="xs" type="submit" disabled={!text.trim() || sending}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </form>
    )
  return (
    <div className={className} data-questions-card={card} ref={root}>
      <div className="flex items-center gap-2 px-3 pt-2 font-mono text-[11px] text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5 text-brand" />
        <span className="text-foreground">
          {questions.length} {questions.length === 1 ? 'question' : 'questions'}
        </span>
        {!phone && <span>· Answer what you can</span>}
        {hasPicks && <span>· picks marked</span>}
      </div>
      <div className="space-y-3 px-3 pt-2 pb-3">
        {questions.map(
          (question, index) =>
            (!phone || index === current) && (
              <fieldset
                key={index}
                disabled={sending}
                onFocus={() => setCurrent(index)}
                data-current={keys && !phone && index === current ? '' : undefined}
                className={cn(
                  'min-w-0 space-y-2',
                  keys && !phone && questions.length > 1 && '-ml-2 border-l-2 pl-1.5',
                  keys &&
                    !phone &&
                    questions.length > 1 &&
                    (index === current ? 'border-brand/60' : 'border-transparent'),
                )}
              >
                <legend className="mb-2 text-[13px] leading-relaxed text-foreground">
                  <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                    {position(question, index)}.
                  </span>
                  {question.text}
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {choices(question).map((option, number) => {
                    const other = !!option.custom
                    const chosen = other
                      ? custom[index]
                      : !custom[index] && answers[index] === option.label
                    return (
                      <button
                        key={number}
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => select(index, number)}
                        className={cn(
                          'flex min-h-9 cursor-pointer items-center gap-2 rounded border px-3 py-2 text-left text-xs transition-colors max-md:min-h-11 max-md:w-full',
                          chosen
                            ? 'border-brand/60 bg-brand/10 text-foreground'
                            : 'border-border bg-background/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        <span className="font-mono text-[10px] opacity-60">
                          {option.key ?? (other ? '…' : number + 1)}
                        </span>
                        <span>
                          <span>{option.label}</span>
                          {option.detail && (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {option.detail}
                            </span>
                          )}
                        </span>
                        {option.recommended && (
                          <span className="ml-1 font-mono text-[9px] text-brand">pick</span>
                        )}
                        {chosen && <CheckIcon className="ml-auto size-3 shrink-0 text-brand" />}
                      </button>
                    )
                  })}
                </div>
                {custom[index] && (
                  <input
                    aria-label={`Your answer to question ${index + 1}`}
                    placeholder="Your answer…"
                    value={answers[index] ?? ''}
                    onChange={(event) =>
                      setAnswers((old) => ({ ...old, [index]: event.target.value }))
                    }
                    className="min-h-11 w-full rounded border border-border bg-background px-3 py-2 text-sm outline-none focus:border-brand/60"
                  />
                )}
              </fieldset>
            ),
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-2">
          {phone ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                disabled={current === 0}
                onClick={() => setCurrent(current - 1)}
              >
                Back
              </Button>
              <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
                {current + 1}/{questions.length}
              </span>
              {current < questions.length - 1 && (
                <Button variant="ghost" size="xs" onClick={() => setCurrent(current + 1)}>
                  Next
                </Button>
              )}
            </>
          ) : (
            keys && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {questions.some((q) => q.options?.some((o) => o.key)) ? 'a–z' : '1–9'} choose
                {questions.length > 1 && ' · ↑↓ question'} · Enter next / send
              </span>
            )
          )}
          <Button
            className="ml-auto"
            variant="ghost"
            size={phone ? 'xs' : 'sm'}
            disabled={sending}
            onClick={() => void run(dismiss)}
            title="Close it without an answer; the agent gets a note"
          >
            Dismiss
          </Button>
          {hasPicks && (
            <Button
              variant="outline"
              size={phone ? 'xs' : 'sm'}
              disabled={sending}
              onClick={accept}
              title="Choose every option marked pick"
            >
              Accept picks
            </Button>
          )}
          <Button size="sm" disabled={!answered.length || sending} onClick={() => void send()}>
            {sending ? 'Sending…' : 'Send answers'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
