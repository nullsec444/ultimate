import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxText, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { defineExtension, defineTask, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { lastAssistant } from '../extensions/status-line/context.ts'
import { describe, expect, it, vi } from 'vitest'
import { createRateSampler, type Rates } from '../extensions/status-line/rates.ts'
import statusLine, { actions } from '../extensions/status-line/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

const counters = (output: number): Rates => ({
  input: output * 2,
  output,
  cacheRead: output * 3,
  cacheWrite: output * 4,
})
const message = (output: number) => {
  const value = fauxAssistantMessage([fauxText('not retained by the collector')])
  value.usage = {
    ...value.usage,
    ...counters(output),
    reasoning: output * 5,
    cost: { ...value.usage.cost, total: output / 1000 },
  }
  return value
}
const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'status-line.fixture',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, caller) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      ),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})
async function settled(tx: Tx, id: ConversationId, output: number) {
  const usage = await tx.doc(UsageDoc, id)
  usage.models['faux/model'] = message(output).usage
  usage.tools.expensive = message(50000).usage
}
async function fixture() {
  const prepared = await prepareHarness({
    ultimateRoot: await temp(),
    userHome: await temp(),
    home: await temp(),
    faux: fauxProvider(),
  })
  prepared.registry.install(defineExtension({ name: 'status-line-fixture', tasks: [anchor] }))
  const opened = await prepared.open()
  let open!: () => Promise<void>
  let close!: () => Promise<void>
  const notices: string[] = []
  const host: Parameters<typeof statusLine>[0] = {
    harness: () => opened.harness,
    onOpen: (callback) => {
      open = callback
    },
    onClose: (callback) => {
      close = callback
    },
    notice: (value) => {
      notices.push(value)
    },
  }
  statusLine(host)
  return {
    ...opened,
    open: () => open(),
    stop: () => close(),
    notices,
    rate: () => actions.rates(null, { host: host as ExtensionHost }),
    async cleanup() {
      await close()
      await opened.close()
      vi.restoreAllMocks()
      vi.useRealTimers()
    },
  }
}

describe('context estimate after a compaction', () => {
  it('marks the meter stale until an answer newer than the marker, though the view lists the marker first', () => {
    const record = (id: number, kind: string, output = 0) =>
      ({
        id,
        kind,
        model: kind === 'pi.assistant' ? [message(output)] : [],
      }) as unknown as EntryRecord
    // A compaction's view: the marker, then the kept entries it heads, including an answer.
    const view = [record(9, 'pi.compaction'), record(4, 'pi.user'), record(5, 'pi.assistant', 7)]
    expect(lastAssistant(view)).toEqual({ stale: true, marker: 9 })
    const answered = lastAssistant([...view, record(10, 'pi.assistant', 8)])
    expect(answered).toMatchObject({ stale: false, message: { usage: { output: 8 } } })
    expect(lastAssistant([record(2, 'pi.assistant', 3)])).toMatchObject({ stale: false })
    expect(lastAssistant([])).toEqual({ stale: false })
  })

  it('counts the prompt and tools before the marker plus the summary and kept entries, once', async () => {
    const f = await fixture()
    try {
      const id = f.root.id
      const system = {
        role: 'system' as const,
        content: 'base',
        sections: { rules: 'r'.repeat(3500) },
        toolsAdded: [{ name: 'bash', description: 'd'.repeat(700), parameters: {} }],
        timestamp: 1,
      }
      const answer = message(1)
      answer.usage = { ...answer.usage, input: 900000, cacheRead: 0, cacheWrite: 0 }
      const { kept, marker } = await f.harness.commit(async (tx) => {
        await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'x'.repeat(7000), timestamp: 0 }],
        })
        await tx.appendEntry(id, { kind: 'pi.system', model: [system] })
        await tx.appendEntry(id, { kind: 'pi.assistant', model: [answer] })
        const first = await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'k'.repeat(350), timestamp: 3 }],
        })
        return {
          kept: first,
          marker: await tx.appendEntry(id, {
            kind: 'pi.compaction',
            head: first.id,
            data: { reason: 'manual' },
            model: [{ role: 'user', content: 's'.repeat(700), timestamp: 4 }],
          }),
        }
      }, context)
      const host = { harness: () => f.harness } as unknown as ExtensionHost
      const estimate = (head: number) =>
        actions.estimate({ marker: head }, { host, conversationId: id })
      const expected =
        estimateMessageTokens({ ...system, sections: { rules: system.sections.rules } }) +
        estimateMessageTokens({ role: 'user', content: 's'.repeat(700), timestamp: 4 }) +
        estimateMessageTokens({ role: 'user', content: 'k'.repeat(350), timestamp: 3 })
      // The 7000-character input before the kept entry and the 900k measured response are gone.
      expect(await estimate(marker.id)).toBe(expected)
      expect(expected).toBeLessThan(2000)
      // A marker that no longer heads the context has no estimate.
      expect(await estimate(kept.id)).toBeNull()
      // A kept `pi.system` entry counts once, through the replayed prompt.
      const again = await f.harness.commit(async (tx) => {
        await tx.appendEntry(id, { kind: 'pi.system', model: [{ ...system, timestamp: 5 }] })
        return tx.appendEntry(id, {
          kind: 'pi.compaction',
          head: kept.id,
          data: { reason: 'manual' },
          model: [{ role: 'user', content: 's'.repeat(700), timestamp: 6 }],
        })
      }, context)
      expect(await estimate(again.id)).toBe(expected)
    } finally {
      await f.cleanup()
    }
  })
})

describe('instance aggregate sampling', () => {
  it('baselines history once and uses signed aggregate differences with a common time', () => {
    const sample = createRateSampler()
    expect(sample(0, counters(1000))).toBeNull()
    expect(sample(2000, counters(1400))).toEqual({ elapsed: 2, rates: counters(200) })
    expect(sample(3000, counters(1380))?.rates.output).toBeCloseTo(380 / 3)
    expect(sample(4000, counters(990))?.rates.output).toBe(0)
    expect(sample(5000, counters(1010))?.rates.output).toBe(2)
  })
  it('decays at idle and interpolates the edge of the 30s window', () => {
    const sample = createRateSampler()
    sample(0, counters(0))
    expect(sample(2000, counters(100))?.rates.output).toBe(50)
    for (let at = 4000; at <= 30000; at += 2000) sample(at, counters(100))
    expect(sample(31000, counters(100))).toEqual({ elapsed: 30, rates: counters(50 / 30) })
    expect(sample(32000, counters(100))?.rates.output).toBe(0)
  })
  it('handles zero elapsed time, gaps and clock reversal without fabricated rates', () => {
    const sample = createRateSampler()
    expect(sample(1000, counters(10))).toBeNull()
    expect(sample(1000, counters(20))).toBeNull()
    expect(sample(2000, counters(20))?.rates.output).toBe(10)
    expect(sample(8000, counters(10000))).toBeNull()
    expect(sample(9000, counters(10010))?.rates.output).toBe(10)
    expect(sample(0, counters(0))).toBeNull()
  })
})

describe('instance commit collector', () => {
  it('seeds atomically across scan pages, counts unrelated roots, child first spend and fork own work without a browser', async () => {
    const f = await fixture()
    try {
      const root = f.root.id
      const ids = await f.harness.commit(async (tx) => {
        const other = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        const task = await tx.createTask(anchor, null, {
          ownership: { kind: 'conversation' },
          conversationId: root,
          background: true,
        })
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task } })
        for (let index = 0; index < 256; index++)
          await tx.createConversation({ ownership: { kind: 'ownerless' } })
        for (const id of [root, other.id, child.id]) await settled(tx, id, 10000)
        for (const [id, output] of [
          [root, 20],
          [child.id, 30],
        ] as const)
          (await tx.doc(LiveDoc, id)).generation = {
            attempt: 1,
            message: JSON.parse(JSON.stringify(message(output))),
          }
        return { other: other.id, child: child.id, task }
      }, context)
      const entry = await f.harness.commit(
        (tx) => tx.appendEntry(root, { kind: 'status-line.fixture', data: {} }),
        context,
      )
      const fork = await f.harness.commit(
        (tx) => tx.forkConversation(root, entry.id, { ownership: { kind: 'ownerless' } }),
        context,
      )
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
      await f.open()
      expect(f.rate()).toBeNull()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.rate()).toMatchObject({ elapsed: 1, rates: counters(0) })
      expect(f.rate()?.totals).toEqual({ ...counters(180000), cost: 180 })
      await f.harness.commit(async (tx) => {
        await settled(tx, root, 10120)
        delete (await tx.doc(LiveDoc, root)).generation
        await settled(tx, ids.other, 10200)
        await settled(tx, ids.child, 10330)
        delete (await tx.doc(LiveDoc, ids.child)).generation
        await settled(tx, fork.id, 50)
        const newTask = await tx.createTask(anchor, null, {
          ownership: { kind: 'conversation' },
          conversationId: root,
          background: true,
        })
        const newChild = await tx.createConversation({
          ownership: { kind: 'task', taskId: newTask },
        })
        await settled(tx, newChild.id, 40) // Its very first publication counts, not a new-member baseline.
      }, context)
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.rate()).toMatchObject({ elapsed: 2, rates: counters(690 / 2) })
      expect(f.rate()?.totals).toEqual({ ...counters(280740), cost: 280.74 })
      for (let index = 0; index < 30; index++) await vi.advanceTimersByTimeAsync(1000)
      expect(f.rate()?.rates.output).toBe(0)
      expect(f.notices).toEqual([])
    } finally {
      await f.cleanup()
    }
  })
})
