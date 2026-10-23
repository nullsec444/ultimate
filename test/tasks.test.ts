import type { ConversationId, ReportTask, TaskId } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { actions, userActions } from '../extensions/tasks/server.ts'
import type { ActionContext } from '../server/actions.ts'
import { createHarnessSettings, reportMessage } from '../server/harness.ts'
import { SettingsManager } from '@earendil-works/pi-coding-agent'

const ctx = (retryTask: (id: number) => Promise<void>) =>
  ({ host: { harness: () => ({ retryTask }) } }) as unknown as ActionContext

it('retry runs the parked task again through Harness.retryTask, and only for the user', async () => {
  const retryTask = vi.fn<(id: number) => Promise<void>>(() => Promise.resolve())
  await expect(actions.retry({ id: 7 }, ctx(retryTask))).resolves.toBeNull()
  expect(retryTask).toHaveBeenCalledWith(7, expect.anything())
  await expect(actions.retry({ id: 'x' }, ctx(retryTask))).rejects.toThrow('Expected a task id')
  expect(userActions).toEqual(['retry'])
})

it('a report notice names what failed', () => {
  const task = {
    id: 12 as TaskId,
    kind: 'pi.generation',
    conversationId: 4 as ConversationId,
  } as ReportTask
  expect(
    reportMessage(new Error('cut off 5 times'), {
      type: 'task_parked',
      task,
      extension: 'messages',
    }),
  ).toBe('task parked: task #12 (pi.generation) in #4, extension messages. Error: cut off 5 times')
  expect(
    reportMessage(new Error('boom'), { type: 'task_faulted', task, reason: 'restart_limit' }),
  ).toBe('task faulted (restart limit): task #12 (pi.generation) in #4. Error: boom')
  expect(reportMessage(new Error('x'), { type: 'host_error', callback: 'models' })).toBe(
    'host error: host callback models. Error: x',
  )
  expect(reportMessage(new Error('disk'), { type: 'session_failed' })).toBe(
    'session failed. Error: disk',
  )
})

it('compaction overrides per model, with Pi settings replacing them field by field', () => {
  const settings = SettingsManager.inMemory({
    compaction: { modelOverrides: { 'openai-codex/gpt-6.1-sol': { keepRecentTokens: 9000 } } },
  })
  const { modelOverrides } = createHarnessSettings(settings, () => []).compaction!
  expect(modelOverrides?.['openai-codex/gpt-6.1-sol']).toEqual({
    reserveTokens: 32768,
    keepRecentTokens: 9000,
    backgroundTokens: 65536,
  })
  expect(modelOverrides?.['claude-code/claude-opus-5-5']?.backgroundTokens).toBe(131072)
})
