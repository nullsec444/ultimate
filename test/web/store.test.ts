import type { Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../../web/src/sdk/store.ts'
import type { ServerEvents } from '../../shared/protocol.ts'

import { FakeSource } from './fake-source.ts'

function setup(retryMs = 5) {
  const sources: FakeSource[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ providers: [], models: [] }),
  )
  const onFallback = vi.fn<() => void>()
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    fetch,
    retryMs,
    onFallback,
  })
  store.start()
  return { store, sources, fetch, onFallback, latest: () => sources.at(-1)! }
}

const user = (id: number, text: string) => ({
  id,
  conversationId: 1,
  kind: 'pi.user',
  model: [{ role: 'user' as const, content: text, timestamp: id }],
})
const view = (
  entries: ReturnType<typeof user>[],
  docs: ConversationView['docs'] = {},
): ConversationView => ({ conversation: { id: 1 }, entries, docs }) as unknown as ConversationView
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const tick = () => vi.advanceTimersByTimeAsync(10)

describe('web replica store', () => {
  it('applies ops to the snapshot and starts over from a fresh snapshot after a reconnect', () => {
    const { store, latest } = setup()
    const source = latest()
    expect(source.url).toBe('/api/events')
    expect(store.getState().connection.status).toBe('connecting')
    source.open()
    expect(store.getState().connection.status).toBe('open')

    source.send('view', view([user(1, 'hello')], { 'pi.live': {} }))
    const ops: Op[] = [
      ['s', ['docs', 'pi.live', 'run'], { taskId: 2, inputs: [1] }],
      ['p', ['entries'], 1, 0, [user(3, 'steer')]],
    ]
    source.send('ops', ops)
    source.send('ops', [['a', ['entries', 1, 'model', 0, 'content'], ' now']])
    const replica = store.getState().view!
    expect(replica.entries.map((entry) => entry.id)).toEqual([1, 3])
    expect(replica.entries[1].model?.[0]).toMatchObject({ content: 'steer now' })
    expect(replica.docs['pi.live']).toEqual({ run: { taskId: 2, inputs: [1] } })
    // Unchanged entries keep their identity, so the transcript re-renders only what changed.
    source.send('ops', [['d', ['docs', 'pi.live', 'run']]])
    expect(store.getState().view!.entries[0]).toBe(replica.entries[0])

    // The root conversation's UI document rides along on every stream.
    source.send('ui', { value: { 'shell.panelOpen': true } })
    source.send('uiOps', { ops: [['s', ['shell.surface'], 'example']] })
    expect(store.getState().shared).toEqual({ 'shell.panelOpen': true, 'shell.surface': 'example' })

    source.drop()
    expect(store.getState().connection.status).toBe('reconnecting')
    // EventSource reopened the same stream; the server sends a full snapshot first.
    source.open()
    source.send('view', view([user(1, 'hello'), user(3, 'steer now'), user(4, 'next')]))
    expect(store.getState().view!.entries.map((entry) => entry.id)).toEqual([1, 3, 4])
    expect(store.getState().view!.docs).toEqual({})
    expect(store.getState().connection.status).toBe('open')
    store.stop()
  })

  it('streams extension documents of the shown conversation', async () => {
    const { store, sources, latest } = setup()
    latest().open()
    const release = store.watchDoc('test.counter')
    await tick()
    expect(sources).toHaveLength(2)
    expect(sources[0].closed).toBe(true)
    expect(latest().url).toBe('/api/events?docs=test.counter')

    latest().send('doc', { kind: 'test.counter', value: { count: 0 } })
    latest().send('docOps', { kind: 'test.counter', ops: [['s', ['count'], 1]] })
    expect(store.getState().docs['test.counter']).toEqual({ count: 1 })
    // Documents nobody asked for are ignored.
    latest().send('doc', { kind: 'other', value: { x: 1 } })
    expect(store.getState().docs.other).toBeUndefined()

    release()
    expect(store.getState().docs['test.counter']).toBeUndefined()
    latest().send('docOps', { kind: 'test.counter', ops: [['s', ['count'], 2]] })
    expect(store.getState().docs['test.counter']).toBeUndefined()
    // Watched again: the old stream's ops wait for the new stream's snapshot.
    store.watchDoc('test.counter')
    latest().send('docOps', { kind: 'test.counter', ops: [['s', ['count'], 3]] })
    expect(store.getState().docs['test.counter']).toBeUndefined()
    await tick()
    latest().send('doc', { kind: 'test.counter', value: { count: 3 } })
    expect(store.getState().docs['test.counter']).toEqual({ count: 3 })
    store.stop()
  })

  it('streams documents of given conversations on one stream per conversation', async () => {
    const { store, sources, latest } = setup()
    latest().open()
    const tasks = store.watchDocOf(1, 'test.tasks')
    const tasksAgain = store.watchDocOf(1, 'test.tasks')
    const overview = store.watchDocOf(1, 'test.overview')
    const plan = store.watchDocOf(7, 'test.plan')
    await tick()
    // The shown conversation's stream stays as it is; each watched conversation gets one stream of all its kinds.
    expect(sources.map((source) => [source.url, source.closed])).toEqual([
      ['/api/events', false],
      ['/api/events?conversation=1&docs=test.overview%2Ctest.tasks', false],
      ['/api/events?conversation=7&docs=test.plan', false],
    ])
    const [, root, coordinator] = sources

    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 0]] })
    expect(store.getState().docsOf[1]).toEqual({})
    root.send('doc', { kind: 'test.tasks', value: { n: 1 } })
    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 2]] })
    coordinator.send('doc', { kind: 'test.plan', value: { epics: {} } })
    expect(store.getState().docsOf).toEqual({
      1: { 'test.tasks': { n: 2 } },
      7: { 'test.plan': { epics: {} } },
    })
    // Documents of the shown conversation are a separate replica.
    expect(store.getState().docs).toEqual({})

    // Showing another conversation leaves these streams alone.
    store.show(7)
    await tick()
    expect([root.closed, coordinator.closed]).toEqual([false, false])
    expect(sources).toHaveLength(4)

    // A server that refuses the stream (a restart) gets a new one; the value stays until its snapshot.
    root.drop(true)
    await tick()
    const reopened = latest()
    expect(reopened.url).toBe(root.url)
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 2 })
    reopened.send('doc', { kind: 'test.tasks', value: { n: 3 } })
    root.send('doc', { kind: 'test.tasks', value: { n: 0 } })
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 3 })

    // Released and watched again before the next tick: the stream carries on.
    overview()
    store.watchDocOf(1, 'test.overview')
    await tick()
    expect(reopened.closed).toBe(false)

    // A kind nobody watches leaves its conversation's stream; the last one closes it.
    tasks()
    await tick()
    expect(reopened.closed).toBe(false)
    tasksAgain()
    await tick()
    expect(reopened.closed).toBe(true)
    expect(latest().url).toBe('/api/events?conversation=1&docs=test.overview')
    expect(store.getState().docsOf[1]).toEqual({})
    plan()
    await tick()
    expect(coordinator.closed).toBe(true)
    expect(store.getState().docsOf[7]).toBeUndefined()

    store.stop()
    expect(latest().closed).toBe(true)
  })

  it('shows another conversation on its own stream and falls back to the root when it cannot open', async () => {
    const { store, sources, latest, onFallback } = setup()
    latest().open()
    latest().send('view', view([user(1, 'root')]))
    store.show(7)
    expect(store.getState().view).toBeUndefined()
    await tick()
    expect(sources[0].closed).toBe(true)
    expect(latest().url).toBe('/api/events?conversation=7')

    // The server answered 404: EventSource gives up, the store reopens the root stream.
    latest().drop(true)
    expect(store.getState().requested).toBeUndefined()
    expect(onFallback).toHaveBeenCalledOnce()
    await tick()
    expect(latest().url).toBe('/api/events')
    store.stop()
  })

  it('refreshes models after (re)starts and keeps notices', async () => {
    const { store, latest, fetch } = setup()
    const source = latest()
    source.open()
    const system = {
      process: { pid: 1, generation: 1, node: 'v26', startedAt: '', url: '' },
    } as ServerEvents['system']
    source.send('system', system)
    await vi.waitFor(() => expect(store.getState().models).toEqual({ providers: [], models: [] }))
    expect(fetch).toHaveBeenCalledOnce()
    source.send('system', { ...system, process: { ...system.process, generation: 2 } })
    expect(fetch).toHaveBeenCalledTimes(2)

    source.send('notice', { level: 'warning', message: 'Unknown extension document: x' })
    expect(store.getState().notices.map((notice) => notice.message)).toEqual([
      'Unknown extension document: x',
    ])
    store.stop()
  })
})
