import type { AssistantMessage } from '@earendil-works/pi-ai'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { readHealth, record, reset } from './store.ts'
import { HealthApi } from './api.ts'
import { LoginChanged } from '../models/api.ts'
import type { Flip, HealthEntry } from './store.ts'
import { Changed } from './refs.ts'

/** The entry a terminal provider message records: `error` → a failure, `aborted` → nothing, else a success. */
export function responseEntry(message: AssistantMessage, now: number): HealthEntry | undefined {
  if (message.stopReason === 'aborted') return undefined
  if (message.stopReason === 'error')
    return { lastFail: now, error: message.errorMessage ?? 'error', lastUsed: now }
  return { lastOk: now, lastUsed: now }
}

/**
 * Emit `health.changed` for each flip that changed a provider's state, in a commit of its own: the state lives in the
 * machine's health file, not in storage. Nothing while storage is closed; a failure only logs, health is advisory.
 */
export async function announce(host: Pick<ExtensionHost, 'harness' | 'emit'>, flips: Flip[]) {
  const changed = flips.filter((flip) => flip.from !== flip.to)
  if (!changed.length) return
  let harness: ReturnType<ExtensionHost['harness']>
  try {
    harness = host.harness()
  } catch {
    // Storage is closed (a core swap): the next write that flips a state is announced.
    return
  }
  await harness
    .commit(async (tx) => {
      for (const { provider, to, error } of changed)
        await host.emit(tx, Changed, { provider, state: to, ...(error ? { error } : {}) })
    }, context)
    .catch((error: unknown) => console.error('health: announcing a change failed:', error))
}

/** Record `entry` in this machine's health file and hand the flip to `flipped`. */
export async function recordHealth(
  userHome: string,
  provider: string,
  entry: HealthEntry,
  flipped: (flips: Flip[]) => Promise<void> = async () => {},
) {
  await flipped([await record(userHome, provider, entry)])
}

export default function health(host: ExtensionHost) {
  // A login added, replaced or removed through Ultimate makes the provider's record meaningless: start it over.
  // Each write that flips a provider's state is announced as `health.changed`.
  const flipped = (flips: Flip[]) => announce(host, flips)
  host.react('login-changed', [LoginChanged], async (tx, { data }) => {
    // In the reactor's transaction: its retry after a failure resets again but announces nothing twice.
    for (const { provider, from, to } of await reset(host.userHome, [data.provider]))
      if (from !== to) await host.emit(tx, Changed, { provider, state: to })
  })
  host.implement(HealthApi, {
    // Only providers with a login here: an entry left from a removed login says nothing about this machine.
    providers: async () =>
      (await readHealth(host.userHome)).filter(
        (entry) => host.modelRuntime.getProviderAuthStatus(entry.provider).configured,
      ),
  })
  return defineExtension({
    name: 'health',
    hooks: [
      hook(GenerationTask, {
        afterResponse(message) {
          const entry = responseEntry(message, Date.now())
          // Only providers with a login here: a stray model reference to another fails, which is not its health.
          if (!entry || !host.modelRuntime.getProviderAuthStatus(message.provider).configured)
            return
          recordHealth(host.userHome, message.provider, entry, flipped).catch((error: unknown) => {
            // Health is advisory: a failed write must never fail or delay the agent's generation.
            console.error('health: recording a response failed:', error)
          })
        },
      }),
    ],
  })
}
