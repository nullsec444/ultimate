import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { TaskId } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { RetryAction, StartedAction } from './refs.ts'

export default { name: 'tasks' }

// A parked task crashed the process five times in a row; only the user decides to risk a sixth.
export const userActions = ['retry']

export const actions = {
  /** When each of `ids` first ran, in wall-clock milliseconds; tasks not yet started or gone are left out. */
  started: implementAction(StartedAction, async (args, { host }) => {
    const ids = (args as { ids?: unknown } | null)?.ids
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id)))
      throw new Error('Expected task ids')
    return host.harness().commit(async (tx) => {
      const started: Record<string, number> = {}
      for (const id of ids as number[]) {
        const at = (await tx.task(id as TaskId))?.startedAt
        if (at !== undefined) started[id] = at
      }
      return started
    }, context)
  }),
  /** Run a task parked by the crash-loop guard again; does nothing for a task that is not parked. */
  retry: implementAction(RetryAction, async (args, { host }) => {
    const id = (args as { id?: unknown } | null)?.id
    if (!Number.isSafeInteger(id)) throw new Error('Expected a task id')
    await host.harness().retryTask(id as TaskId, context)
    return null
  }),
}
