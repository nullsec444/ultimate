// Keeps the `openai-codex` login in Pi's auth.json on the ChatGPT account with the most headroom.
//
// Pool: ~/.pi/agent/codex-pool.json, `{ "openai-codex": [{ email, type, access, refresh, expires, accountId }] }`.
// Each run reads every account's usage, refreshes expired inactive tokens, and swaps the active account out once
// its 5-hour or weekly window is at SWITCH_AT percent and another account has room. Pi rereads auth.json under its
// lock, so a swap takes effect on the next model call. Run it from a timer; it exits after one pass.
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROVIDER = 'openai-codex'
const SWITCH_AT = Number(process.env.CODEX_ROTATE_SWITCH_AT ?? 90)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
const authPath = join(agentDir, 'auth.json')
const poolPath = join(agentDir, 'codex-pool.json')

interface Account {
  email: string
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
  [key: string]: unknown
}

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`)
}

function writeJson(path: string, value: unknown) {
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, path)
}

/** Holds auth.json's lock the way pi's proper-lockfile does: an atomic `auth.json.lock` directory. */
async function withAuthLock<T>(fn: () => T): Promise<T> {
  const lock = `${authPath}.lock`
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock)
      else if (attempt > 100) throw new Error('auth.json stayed locked', { cause: error })
      else await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return fn()
  } finally {
    rmdirSync(lock)
  }
}

async function refresh(account: Account): Promise<Account> {
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) throw new Error(`refresh ${response.status}`)
  const json = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  return {
    ...account,
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

/** The fuller of the account's two windows, in percent; 100 once a limit is reached. */
async function usage(account: Account): Promise<number> {
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      Authorization: `Bearer ${account.access}`,
      'ChatGPT-Account-Id': account.accountId,
      'User-Agent': 'codex_cli_rs/0.163.0',
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`usage ${response.status}`)
  const { rate_limit: limit } = (await response.json()) as {
    rate_limit?: {
      limit_reached?: boolean
      primary_window?: { used_percent: number }
      secondary_window?: { used_percent: number }
    }
  }
  if (!limit) return 0
  if (limit.limit_reached) return 100
  return Math.max(
    limit.primary_window?.used_percent ?? 0,
    limit.secondary_window?.used_percent ?? 0,
  )
}

const pool =
  (JSON.parse(readFileSync(poolPath, 'utf8')) as Record<string, Account[]>)[PROVIDER] ?? []
const active = await withAuthLock(
  () => (JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, Account>)[PROVIDER],
)
if (!active || pool.length === 0) {
  log('nothing to rotate')
  process.exit(0)
}
// The active login is the freshest copy of its account: pi refreshes it in auth.json, not in the pool.
// An active login missing from the pool joins it, so rotating away from it does not lose it.
let activeIndex = pool.findIndex((account) => account.accountId === active.accountId)
if (activeIndex >= 0) pool[activeIndex] = { ...pool[activeIndex], ...active }
else activeIndex = pool.push({ ...active }) - 1

const used = new Map<string, number>()
for (const [index, account] of pool.entries()) {
  try {
    if (index !== activeIndex && account.expires < Date.now() + 60_000)
      pool[index] = await refresh(account)
    used.set(account.accountId, await usage(pool[index]))
  } catch (error) {
    log(`${account.email}: ${(error as Error).message}`)
  }
}
writeJson(poolPath, { [PROVIDER]: pool })

const activeUsed = used.get(active.accountId) ?? 100
const best = pool
  .filter((account) => used.has(account.accountId) && account.accountId !== active.accountId)
  .toSorted((a, b) => used.get(a.accountId)! - used.get(b.accountId)!)[0]
log(pool.map((account) => `${account.email}=${used.get(account.accountId) ?? '?'}%`).join(' '))

if (activeUsed >= SWITCH_AT && best && used.get(best.accountId)! < activeUsed) {
  const { email: _email, plan: _plan, ...credential } = best
  await withAuthLock(() => {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>
    writeJson(authPath, { ...auth, [PROVIDER]: credential })
  })
  log(`switched ${PROVIDER} to ${best.email}`)
}
