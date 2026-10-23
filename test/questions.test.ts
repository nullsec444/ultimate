import { apis, eventHost, temp, until } from './helpers.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { awaitWithContext } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Task } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ConversationsService } from '../extensions/conversations/api.ts'
import { emit } from '../server/events.ts'
import { accountResponse, askSummaryModel } from '../extensions/conversations/summary.ts'
import { summaryModel } from '../extensions/conversations/summary-model.ts'
import messagesExtension from '../extensions/messages/server.ts'
import { Asked, Messages } from '../extensions/messages/api.ts'
import questionsExtension, {
  actions,
  MessageQuestions,
  decisionQuestions,
  parseQuestions,
  QUESTIONS_SYSTEM,
  userActions,
} from '../extensions/questions/server.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { decisionCases } from './decisions.cases.ts'
import type { SubagentsService } from '../extensions/subagents/api.ts'
import { Workspaces } from '../extensions/workspaces/workspaces.ts'

const hosts: OpenHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, release: resolve }
}
async function fixture() {
  const home = await temp('ultimate-messages-questions-')
  const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home, faux: true })
  let opened: OpenHost
  const services = new Map<string, unknown>()
  const openers: (() => Promise<void>)[] = []
  const closers: (() => Promise<void>)[] = []
  // Messages’ `board.asked` reaches questions' reactor through a real event log, as on a server.
  const events = eventHost(() => opened.harness, 'questions')
  openers.push(async () => void (await events.start()))
  closers.push(async () => void (await events.stop()))
  const host = {
    ...prepared,
    userHome: home,
    projectSettings: async () => ({}),
    harness: () => opened.harness,
    ...apis(services),
    doc: () => undefined,
    onOpen: (fn: () => Promise<void>) => openers.push(fn),
    onClose: (fn: () => Promise<void>) => closers.push(fn),
    emit: events.emit,
    react: events.react,
    notice: (message: string) => {
      throw new Error(message)
    },
  } as unknown as ExtensionHost
  services.set('conversations', {
    summaryModel: () => summaryModel(host),
    askSummaryModel,
    accountResponse,
  } satisfies Partial<ConversationsService>)
  // Messages’ core dependencies: no standing agents to list, no worktrees.
  services.set('subagents', { residents: async () => [] } satisfies Partial<SubagentsService>)
  services.set('workspaces', { doc: Workspaces })
  prepared.registry.install(messagesExtension(host))
  const extension = questionsExtension(host)
  let beforeCommit: ReturnType<typeof gate> | undefined
  let committing = false
  prepared.registry.install({
    ...extension,
    tasks: extension.tasks!.map((value) => {
      const task = value as Task<JsonValue, { phase: string }, JsonValue, object>
      return {
        definition: {
          ...task.definition,
          phases: {
            ...task.definition.phases,
            extract: (
              ...[record, runtime, ctx]: Parameters<typeof task.definition.phases.extract>
            ) =>
              task.definition.phases.extract(
                record,
                {
                  ...runtime,
                  commit: async (...args) => {
                    if (beforeCommit) {
                      committing = true
                      await awaitWithContext(beforeCommit.promise, ctx)
                    }
                    return runtime.commit(...args)
                  },
                },
                ctx,
              ),
          },
        },
      }
    }),
  })
  let extraction: unknown = { questions: [{ text: 'Keep it running?', kind: 'confirm' }] }
  let hold: ReturnType<typeof gate> | undefined
  const extract = vi.fn<() => void>()
  const observed: string[] = []
  const extractionInputs: string[] = []
  const route: FauxResponseFactory = async (transcript) => {
    prepared.faux!.appendResponses([route])
    const first = transcript.messages[0]
    if (first?.role === 'system' && first.content === QUESTIONS_SYSTEM) {
      // The root stands in for @ultimate while sending, so its final answer to the typed SEND is read too; it asks nothing.
      if (transcript.messages.at(-1)?.content === 'Sent.')
        return fauxAssistantMessage([fauxText('{"questions":[]}')])
      const content = transcript.messages.at(-1)?.content
      if (typeof content === 'string') extractionInputs.push(content)
      extract()
      if (hold) await hold.promise
      return fauxAssistantMessage([fauxText(JSON.stringify(extraction))])
    }
    const last = transcript.messages.at(-1)!
    const text = typeof last.content === 'string' ? last.content : ''
    observed.push(text)
    if (last.role === 'user' && text.startsWith('ASK '))
      return fauxAssistantMessage([fauxText(text.slice(4))])
    if (last.role === 'user' && text.startsWith('SEND '))
      return fauxAssistantMessage([fauxToolCall('message', JSON.parse(text.slice(5)))], {
        stopReason: 'toolUse',
      })
    return fauxAssistantMessage([fauxText('Sent.')])
  }
  prepared.faux!.setResponses([route])
  const open = async () => {
    opened = await prepared.open()
    hosts.push(opened)
    for (const fn of openers) await fn()
  }
  const close = async () => {
    for (const fn of closers) await fn()
    hosts.splice(hosts.indexOf(opened), 1)
    await opened.close()
  }
  await open()
  const log = () => opened.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const state = () => opened.harness.snapshot(MessageQuestions, ROOT_CONVERSATION_ID, context)
  // Settled: every event reacted to and every task done.
  const settled = () =>
    until(
      async () =>
        (await events.settled()) &&
        (await opened.harness.commit(
          async (tx) =>
            (await tx.scanTasks({}, 1000)).items.every((task) => task.state.status === 'terminal'),
          context,
        )),
    )
  const send = async (extra = {}) => {
    // Only @ultimate may message the user, so the root stands in for it while it sends.
    await opened.harness.commit(async (tx) => {
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = opened.root.id
    }, context)
    await (
      await opened.root.submit(
        {
          type: 'input',
          content: `SEND ${JSON.stringify({ to: 'user', text: 'Keep it running?', ...extra })}`,
        },
        context,
      )
    ).wait(context)
    await opened.harness.commit(async (tx) => {
      delete (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
    }, context)
    return (await log())!.messages.at(-1)!.id
  }
  const action = () => ({ host, signal: new AbortController().signal }) as ActionContext
  const answer = (messageId: number, answers = [{ question: 'Keep it running?', answer: 'Yes' }]) =>
    actions.answer({ messageId, answers }, action())
  /** A new conversation registered as the standing @ultimate. */
  const ultimate = async () => {
    const conversation = await opened.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    const agent = await opened.root.agent(context)
    await opened.harness.commit(async (tx) => {
      await configure(tx, conversation.id, { model: agent.model, tools: agent.tools })
      ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = conversation.id
    }, context)
    return conversation.id
  }
  const type = async (id: ConversationId, content: string) => {
    const conversation = (await opened.harness.conversation(id, context))!
    return (await conversation.submit({ type: 'input', content }, context)).wait(context)
  }
  const dismiss = (messageId: number) => actions.dismiss({ messageId }, action())
  const entries = async (id: ConversationId) =>
    (
      await opened.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 1000), context)
    ).items.toSorted((a, b) => a.id - b.id)
  return {
    ultimate,
    type,
    dismiss,
    entries,
    get opened() {
      return opened
    },
    host,
    prepared,
    send,
    log,
    state,
    extract,
    observed,
    extractionInputs,
    settled,
    action,
    answer,
    open,
    close,
    result: (value: unknown) => {
      extraction = value
    },
    hold: (value: ReturnType<typeof gate>) => {
      hold = value
    },
    pauseCommit: (value: ReturnType<typeof gate> | undefined) => {
      beforeCommit = value
    },
    committing: () => committing,
  }
}

it('extracts once only for reply-expected agent messages to the user', async () => {
  const f = await fixture()
  await f.send({ reply: false })
  await f.send({
    to: `#${(await f.opened.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)).id}`,
    reply: true,
  })
  await f.settled()
  expect(f.extract).not.toHaveBeenCalled()
  const id = await f.send()
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect(await f.state()).toMatchObject({
    requested: [id],
    asked: { [id]: [{ text: 'Keep it running?', kind: 'confirm' }] },
  })
  // The event again, as if delivered twice: the message was requested already.
  await f.opened.harness.commit((tx) => emit(tx, Asked, { message: id, from: 1 }), context)
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
})

it('posts exactly one reply atomically, wakes the sender, and rejects unknown or duplicate answers', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  expect(userActions).toEqual(['answer', 'dismiss'])
  await expect(f.answer(id, [{ question: 'Unknown', answer: 'Yes' }])).rejects.toThrow(
    'Unknown question',
  )
  await expect(
    f.answer(id, [
      { question: 'Keep it running?', answer: 'Yes' },
      { question: 'Keep it running?', answer: 'No' },
    ]),
  ).rejects.toThrow('Unknown question')
  await expect(f.answer(id, [])).rejects.toThrow('Invalid answers')
  const results = await Promise.allSettled([f.answer(id), f.answer(id)])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(
    String(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ),
  ).toContain('These questions are no longer open')
  await f.settled()
  expect((await f.log())!.messages).toMatchObject([
    { id, state: 'answered' },
    { from: 'user', to: 1, re: id, text: 'Keep it running?: Yes' },
    { from: 1, to: 'user', reply: false },
  ])
  expect(f.observed.some((text) => text.includes('Keep it running?: Yes'))).toBe(true)
  await expect(f.answer(id)).rejects.toThrow('These questions are no longer open')
})

it('reads a decisions block without the model and answers in its numbering', async () => {
  const f = await fixture()
  const text =
    'Decisions:\n1. **Scope:** (a) all of it; (b) the format only.\n2. **Test:** (a) add it; (b) skip it.\nMy picks: 1a 2b.'
  const id = await f.send({ text })
  await f.settled()
  expect(f.extract).not.toHaveBeenCalled()
  expect((await f.state())!.asked[String(id)]).toEqual([
    {
      text: 'Scope',
      kind: 'choice',
      ref: '1',
      options: [
        { key: 'a', label: 'all of it', recommended: true },
        { key: 'b', label: 'the format only' },
      ],
    },
    {
      text: 'Test',
      kind: 'choice',
      ref: '2',
      options: [
        { key: 'a', label: 'add it' },
        { key: 'b', label: 'skip it', recommended: true },
      ],
    },
  ])
  await f.answer(id, [
    { question: 'Scope', answer: 'all of it' },
    { question: 'Test', answer: 'only the keyboard one' },
  ])
  await f.settled()
  expect((await f.log())!.messages.find((m) => m.re === id)?.text).toBe(
    '1a. Scope: all of it\n\n2: only the keyboard one',
  )
})

it('keeps a card answerable across typed input and discards an extraction its message outlived', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  await f.type(f.opened.root.id, 'Typed reply')
  await f.answer(id)
  await expect(f.answer(id)).rejects.toThrow('These questions are no longer open')
  await f.settled()
  const hold = gate()
  f.hold(hold)
  const stale = await f.send()
  await until(() => f.extract.mock.calls.length === 2)
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find((m) => m.id === stale)!.state =
      'answered'
  }, context)
  hold.release()
  await f.settled()
  expect((await f.state())!.asked[String(stale)]).toBeUndefined()
})

it('discards empty and invalid extractions', async () => {
  const f = await fixture()
  for (const result of [
    { questions: [] },
    { questions: [{ text: 'Bad', kind: 'choice' }] },
    null,
  ]) {
    f.result(result)
    await f.send()
    await f.settled()
  }
  expect(f.extract).toHaveBeenCalledTimes(3)
  expect((await f.state())!.asked).toEqual({})
})

it('resumes a memoized response during reopen and never extracts again after completion', async () => {
  const f = await fixture()
  f.pauseCommit(gate())
  const id = await f.send()
  await until(f.committing)
  expect(f.extract).toHaveBeenCalledTimes(1)
  await f.close()
  f.pauseCommit(undefined)
  await f.open()
  await f.settled()
  expect((await f.state())!.asked[String(id)]).toHaveLength(1)
  expect(f.extract).toHaveBeenCalledTimes(1)
  await f.close()
  await f.open()
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
  expect((await f.state())!.requested).toEqual([id])
})

it('prunes extraction state to messages still in the Messages log', async () => {
  const f = await fixture()
  const id = await f.send()
  await f.settled()
  await f.opened.harness.commit(async (tx) => {
    ;(await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages = []
  }, context)
  const next = await f.send()
  await f.settled()
  expect((await f.state())!.requested).toEqual([next])
  expect((await f.state())!.asked[String(id)]).toBeUndefined()
})

it("keeps @ultimate's open message to the user open until its card answers it", async () => {
  const f = await fixture()
  const id = await f.ultimate()
  await f.type(id, `SEND ${JSON.stringify({ to: 'user', text: 'Keep it running?' })}`)
  await f.settled()
  const message = (await f.log())!.messages.at(-1)!
  expect(message).toMatchObject({ from: id, state: 'delivered' })
  expect((await f.state())!.asked[String(message.id)]).toHaveLength(1)
  await f.type(
    f.opened.root.id,
    `SEND ${JSON.stringify({ to: `#${id}`, text: 'Unrelated update' })}`,
  )
  await f.settled()
  expect((await f.log())!.messages.find((m) => m.id === message.id)?.state).toBe('delivered')
  expect((await f.state())!.asked[String(message.id)]).toHaveLength(1)
  await f.type(id, 'Something else entirely')
  await f.settled()
  expect((await f.log())!.messages.find((m) => m.id === message.id)?.state).toBe('delivered')
  // The run that typed input started went in after a line naming the open question.
  const typed = await f.entries(id)
  const note = typed.findLast((entry) => entry.kind === 'board.open')!
  expect(note.data).toEqual({ ids: [message.id] })
  expect(note.model?.[0]?.content).toMatch(
    new RegExp(
      `^Open questions to the user.*\\n- message ${message.id}: Keep it running\\? \\(asked just now\\)$`,
      's',
    ),
  )
  expect(typed[typed.indexOf(note) + 1]).toMatchObject({ kind: 'pi.user' })
  await f.answer(message.id)
  expect((await f.log())!.messages.find((m) => m.id === message.id)?.state).toBe('answered')
  await expect(f.answer(message.id)).rejects.toThrow('These questions are no longer open')
  // With nothing open, the next run starts without the line.
  await f.settled()
  const count = (await f.entries(id)).filter((entry) => entry.kind === 'board.open').length
  await f.type(id, 'Thanks')
  expect((await f.entries(id)).filter((entry) => entry.kind === 'board.open')).toHaveLength(count)
})

it('answers an open question as free text with a reply to that message, even without extracted questions', async () => {
  const f = await fixture()
  f.result({ questions: [] })
  const id = await f.send({ text: 'What should the tab be called?' })
  await f.settled()
  expect((await f.state())!.asked[String(id)]).toBeUndefined()
  await expect(actions.answer({ messageId: id, text: '  ' }, f.action())).rejects.toThrow(
    'Invalid answers',
  )
  const { id: reply } = await actions.answer({ messageId: id, text: ' Questions ' }, f.action())
  await f.settled()
  const log = (await f.log())!.messages
  expect(log.find((m) => m.id === id)?.state).toBe('answered')
  expect(log.find((m) => m.id === reply)).toMatchObject({ from: 'user', re: id, text: 'Questions' })
  await expect(actions.answer({ messageId: id, text: 'Again' }, f.action())).rejects.toThrow(
    'These questions are no longer open',
  )
})

it('dismisses one open question with a one-way note that starts no run, leaving the others open', async () => {
  const f = await fixture()
  const id = await f.ultimate()
  await f.type(id, `SEND ${JSON.stringify({ to: 'user', text: 'Keep it running?' })}`)
  await f.type(id, `SEND ${JSON.stringify({ to: 'user', text: 'Which layout?' })}`)
  await f.settled()
  const [first, second] = (await f.log())!.messages.slice(-2)
  const before = (await f.entries(id)).filter((entry) => entry.kind === 'pi.assistant').length
  const { id: note } = await f.dismiss(first.id)
  await f.settled()
  const log = (await f.log())!.messages
  expect(log.find((m) => m.id === first.id)?.state).toBe('dismissed')
  expect(log.find((m) => m.id === second.id)?.state).toBe('delivered')
  expect(log.find((m) => m.id === note)).toMatchObject({
    from: 'user',
    to: id,
    re: first.id,
    reply: false,
    state: 'delivered',
  })
  const after = await f.entries(id)
  expect(after.findLast((entry) => entry.kind === 'board.message')?.data).toMatchObject({
    id: note,
    delivery: 'note',
  })
  expect(after.filter((entry) => entry.kind === 'pi.assistant')).toHaveLength(before)
  await expect(f.dismiss(first.id)).rejects.toThrow('These questions are no longer open')
  await expect(f.answer(first.id)).rejects.toThrow('These questions are no longer open')
})

it('does not gate explicit reply-expected Messages asks without question punctuation', async () => {
  const f = await fixture()
  await f.send({ text: 'Please confirm whether to keep it running.' })
  await f.settled()
  expect(f.extract).toHaveBeenCalledTimes(1)
})

// 1326 and 1335 are the shapes the model once missed (stated picks read as already decided).
it.for(decisionCases)('reads real decisions block $id into its card', ({ text, n, opts, rec }) => {
  const questions = decisionQuestions(text)
  expect({
    n: questions.length,
    opts: questions.map((q) => q.options?.length ?? 2),
    rec: questions.map((q, i) =>
      rec[i] === null ? null : (q.options?.findIndex((o) => o.recommended) ?? -1),
    ),
  }).toEqual({ n, opts, rec })
})

it('validates extracted choices and ignores fields outside the schema', () => {
  expect(
    parseQuestions(
      '{"questions":[{"text":"Which?","kind":"choice","options":[{"label":"Small","recommended":true}],"extra":"ignore"}]}',
    ),
  ).toEqual([{ text: 'Which?', kind: 'choice', options: [{ label: 'Small', recommended: true }] }])
  expect(() =>
    parseQuestions('{"questions":[{"text":"Which?","kind":"choice","options":[]}]}'),
  ).toThrow('Invalid options')
  // A repeated label would answer as the first option, so it is left out.
  expect(
    parseQuestions(
      '{"questions":[{"text":"Which?","kind":"choice","options":[{"label":"Keep","key":"a"},{"label":" Keep ","key":"b"},{"label":"Drop","key":"c"}]}]}',
    )[0].options,
  ).toEqual([
    { label: 'Keep', key: 'a' },
    { label: 'Drop', key: 'c' },
  ])
})
