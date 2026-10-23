import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isModelType,
} from '@earendil-works/pi-ai/models'
import { fauxServer, temp, until, attach, post, sourceCopy } from '../helpers.ts'
import { createServer } from '../../server/main.ts'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { context } from '../../server/harness.ts'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { Message } from '@earendil-works/pi-ai'

it('loads pinned TypeScript upstream through Vite, tracks external auth, and cleans up reload/disable', async () => {
  const home = await temp()
  const cli = join(home, 'claude')
  const payload = join(home, 'status.json')
  await writeFile(
    cli,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  process.stdout.write(readFileSync(${JSON.stringify(payload)}, 'utf8'))
} else {
  writeFileSync(${JSON.stringify(payload + '.discovery')}, 'catalog-only')
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') console.log(JSON.stringify({
      type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: {
        models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet discovered', description: 'Sonnet', supportsAdaptiveThinking: true, supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }]
      } }
    }))
  }
}
`,
  )
  await chmod(cli, 0o755)
  await writeFile(payload, JSON.stringify({ loggedIn: false }))
  vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const settings = join(projectRoot, '.ultimate/settings.json')
  await writeFile(settings, '{}')
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
  })
  const runtime = server.host.modelRuntime
  const status = () =>
    server.extensions.invoke('claude-code', 'status', null, new AbortController().signal)
  try {
    const anthropic = runtime.getProvider('anthropic')
    const provider = runtime.getProvider('claude-code')!
    expect(provider).toBeDefined()
    expect(Object.hasOwn(provider.auth.oauth!, 'login')).toBe(false)
    expect(provider.auth.oauth?.isSubscription).toBe(true)
    expect(typeof provider.streamSimple).toBe('function')
    const staticModels = provider.getModels()
    const sonnet = staticModels.find((model) => model.id === 'claude-sonnet-5')!
    expect(sonnet.thinkingLevelMap?.off).toBeNull()
    expect(getSupportedThinkingLevels(sonnet)).not.toContain('off')
    expect(clampThinkingLevel(sonnet, 'off')).not.toBe('off')
    expect(clampThinkingLevel(sonnet, 'low')).toBe('low')
    const upstream = await server.vite.ssrLoadModule(
      resolve('node_modules/@earendil-works/pi-claude-code/src/provider.ts'),
    )
    expect(staticModels.filter((model) => model.id !== sonnet.id)).toEqual(
      upstream
        .createClaudeCodeProvider()
        .getModels()
        .filter((model: { id: string }) => model.id !== sonnet.id),
    )
    expect(provider.getAllModels!().find((model) => model.id === sonnet.id)).toEqual(sonnet)
    const discovery = await runtime.refresh({ allowNetwork: true, providers: ['claude-code'] })
    expect(discovery.errors.size).toBe(0)
    expect(await readFile(payload + '.discovery', 'utf8')).toBe('catalog-only')
    const discovered = runtime
      .getAllModels()
      .find((model) => model.provider === 'claude-code' && model.id === 'claude-sonnet-5')!
    if (!isModelType(discovered, 'chat')) throw new Error('Expected discovered chat model')
    expect(discovered.name).toMatch(/Sonnet/)
    expect(discovered.thinkingLevelMap?.off).toBeNull()
    expect(getSupportedThinkingLevels(discovered)).not.toContain('off')
    expect(clampThinkingLevel(discovered, 'off')).not.toBe('off')
    expect(await status()).toEqual({
      available: true,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(false)

    await writeFile(
      payload,
      JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: 'private@example.test' }),
    )
    expect(await status()).toEqual({
      available: true,
      loggedIn: true,
      subscription: true,
      plan: 'max',
    })
    expect(runtime.isUsingSubscription('claude-code')).toBe(true)
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(true)

    const file = join(server.host.ultimateRoot, 'extensions/claude-code/server.ts')
    const source = await readFile(file, 'utf8')
    // Hook both registration boundaries deterministically as well as polling:
    // even an unregister/re-register gap shorter than the timer must fail.
    const samples: boolean[] = []
    const sample = () => samples.push(!!runtime.getModel('claude-code', 'claude-sonnet-5'))
    const register = runtime.registerNativeProvider.bind(runtime)
    const unregister = runtime.unregisterProvider.bind(runtime)
    const registration = vi.spyOn(runtime, 'registerNativeProvider').mockImplementation((next) => {
      sample()
      register(next)
      sample()
    })
    const removal = vi.spyOn(runtime, 'unregisterProvider').mockImplementation((id) => {
      unregister(id)
      sample()
    })
    const polling = setInterval(sample, 2)
    try {
      // ultimateRoot is an isolated source copy; never mutate the working checkout here.
      await writeFile(file, source + '\n')
      server.vite.watcher.emit('change', file)
      await until(
        () =>
          runtime.getProvider('claude-code') !== provider && !!runtime.getProvider('claude-code'),
      )
      expect(registration).toHaveBeenCalled()
      expect(removal).not.toHaveBeenCalledWith('claude-code')
      expect(samples.length).toBeGreaterThan(1)
      expect(samples.every(Boolean)).toBe(true)
    } finally {
      clearInterval(polling)
      registration.mockRestore()
      removal.mockRestore()
    }
    await status()
    expect(runtime.isUsingSubscription('claude-code')).toBe(true)
    expect(runtime.getProvider('anthropic')).toBe(anthropic)

    await writeFile(payload, '{invalid json')
    expect(await status()).toEqual({
      available: true,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    expect((await runtime.getAvailable()).some((m) => m.provider === 'claude-code')).toBe(false)
    vi.stubEnv('PI_CLAUDE_CODE_COMMAND', join(home, 'missing'))
    expect(await status()).toEqual({
      available: false,
      loggedIn: false,
      subscription: false,
      plan: null,
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      server.extensions.invoke('claude-code', 'status', null, aborted.signal),
    ).rejects.toThrow(/abort/i)

    await writeFile(settings, JSON.stringify({ extensions: { disable: ['claude-code'] } }))
    await until(() => !runtime.getProvider('claude-code'))
    expect(runtime.getAllModels().some((m) => m.provider === 'claude-code')).toBe(false)
    expect(runtime.getProvider('anthropic')).toBe(anthropic)
  } finally {
    await server.close()
  }
}, 60000)

// A fake CLI that checks replayed history like Anthropic's Messages API: every tool_use id and tool_result
// tool_use_id matches ^[a-zA-Z0-9_-]+$, tool_use ids are unique, and each assistant turn's tool calls are answered by
// the next user frame. A violation is answered as a native API error, which upstream reports as a failed request.
async function validatingClaude(home: string) {
  const cli = join(home, 'claude')
  const requests = join(home, 'requests.jsonl')
  await writeFile(
    cli,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'max' }))
} else {
  const emit = (event) => console.log(JSON.stringify(event))
  const frames = []
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type !== 'user' && frame.type !== 'assistant') continue
    frames.push(frame)
    if (frame.type !== 'user') continue
    if (frame.shouldQuery === false) {
      emit({ type: 'result', subtype: 'success', num_turns: 0 })
      continue
    }
    appendFileSync(${JSON.stringify(requests)}, JSON.stringify(frames) + '\\n')
    const errors = []
    const seen = new Set()
    frames.forEach((frame, index) => frame.message.content.forEach((block, position) => {
      if (block.type !== 'tool_use' && block.type !== 'tool_result') return
      const id = block.type === 'tool_use' ? block.id : block.tool_use_id
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
        errors.push('messages.' + index + '.content.' + position + '.' + (block.type === 'tool_use' ? 'tool_use.id' : 'tool_result.tool_use_id') + ": String should match pattern '^[a-zA-Z0-9_-]+$'")
      if (block.type === 'tool_use') {
        if (seen.has(id)) errors.push('messages.' + index + ': tool_use ids must be unique: ' + id)
        seen.add(id)
        const next = frames[index + 1]?.message.content ?? []
        if (!next.some((result) => result.type === 'tool_result' && result.tool_use_id === id))
          errors.push('messages.' + index + ': tool_use ' + id + ' has no tool_result in the next message')
      } else {
        const previous = frames[index - 1]
        if (previous?.type !== 'assistant' || !previous.message.content.some((use) => use.type === 'tool_use' && use.id === id))
          errors.push('messages.' + index + ': unexpected tool_use_id ' + id + ' in tool_result blocks')
      }
    }))
    const text = errors.length ? 'invalid_request_error: ' + errors.join('; ') : 'Validated.'
    const message = { id: 'msg_test', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    if (errors.length) emit({ type: 'assistant', message, error: 'invalid_request' })
    emit({ type: 'assistant', message })
    emit({ type: 'stream_event', event: { type: 'message_stop' } })
    emit({ type: 'result', subtype: 'success', is_error: false, usage: message.usage })
  }
}
`,
  )
  await chmod(cli, 0o755)
  return { cli, requests }
}

type Frame = { type: string; message: { content: Array<Record<string, unknown>> } }
const toolIds = (frames: Frame[]) =>
  frames.flatMap((frame) =>
    frame.message.content.flatMap((block) =>
      block.type === 'tool_use'
        ? [String(block.id)]
        : block.type === 'tool_result'
          ? [String(block.tool_use_id)]
          : [],
    ),
  )
const toolResult = (toolCallId: string): Message => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text: `result for ${toolCallId}` }],
  isError: false,
  timestamp: 1,
})

it('sends Codex tool ids to Claude Code as valid, paired, collision-free ids without changing history', async () => {
  const home = await temp()
  const { cli, requests } = await validatingClaude(home)
  vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(join(projectRoot, '.ultimate/settings.json'), '{}')
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot,
    home: join(home, 'state'),
    userHome: home,
  }
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  const codex = (ids: string[]): Message => ({
    role: 'assistant',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage,
    stopReason: 'toolUse',
    timestamp: 1,
    content: ids.map((id, index) => ({
      type: 'toolCall',
      id,
      name: 'read',
      arguments: { path: `file-${index}` },
    })),
  })
  // A Claude Code turn with its native replay carrier. Upstream replays the carrier's signed thinking only while the
  // carrier projection matches the message; otherwise it drops thinking from the turn.
  const claude = (id: string): Message => ({
    role: 'assistant',
    api: 'claude-code',
    provider: 'claude-code',
    model: 'claude-sonnet-5',
    usage,
    stopReason: 'toolUse',
    timestamp: 1,
    content: [
      { type: 'thinking', thinking: 'Plan.', thinkingSignature: 'sig-pi' },
      { type: 'text', text: 'Reading.' },
      { type: 'toolCall', id, name: 'read', arguments: { path: 'native' } },
    ],
    diagnostics: [
      {
        type: 'claude-code.native-assistant.v1',
        timestamp: 1,
        details: {
          carrier: {
            version: 1,
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'Plan.', signature: 'sig-native' },
                { type: 'text', text: 'Reading.' },
                { type: 'tool_use', id, name: 'mcp__pi__read', input: { path: 'native' } },
              ],
            },
            projection: {
              text: 'Reading.',
              toolCalls: [{ id, name: 'read', input: { path: 'native' } }],
            },
          },
        },
      },
    ],
  })
  // Parallel Codex calls: a long `call|fc` pair id; `call|1`, whose plain sanitization is the valid Claude id
  // `call_1` used later; `a|b` and `a.b`, which sanitize to the same `a_b`. Results arrive out of order.
  const pair = 'call_abc|fc_' + 'x'.repeat(80)
  const valid = ['call_1', 'toolu_01Valid', 'call_valid-2']
  const history = (later: string[]): Message[] => [
    { role: 'user', content: 'Start.', timestamp: 1 },
    codex([pair, 'call|1', 'a|b', 'a.b']),
    toolResult('a.b'),
    toolResult(pair),
    toolResult('a|b'),
    toolResult('call|1'),
    claude('call_1'),
    toolResult('call_1'),
    claude('native|carrier'),
    toolResult('native|carrier'),
    codex(later),
    ...later.map(toolResult),
    { role: 'user', content: 'Continue.', timestamp: 1 },
  ]
  const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }]
  const sentFrames = async () =>
    (await readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Frame[])
  const request = async (
    server: Awaited<ReturnType<typeof fauxServer>>,
    method: 'stream' | 'streamSimple',
    messages: Message[],
  ) => {
    const provider = server.host.modelRuntime.getProvider('claude-code')!
    const model = server.host.modelRuntime.getModel('claude-code', 'claude-sonnet-5')!
    if (!isModelType(model, 'chat')) throw new Error('Expected chat model')
    const transcript = normalizeContext({ systemPrompt: 'Test.', tools, messages })
    const before = structuredClone(transcript)
    const response = await provider[method](model, transcript).result()
    // The transport gets a copy: the caller's context, and so durable history, is unchanged.
    expect(transcript).toEqual(before)
    expect(response.errorMessage).toBeUndefined()
    expect(response.content).toEqual([{ type: 'text', text: 'Validated.' }])
    return (await sentFrames()).at(-1)!
  }

  let server = await fauxServer(options)
  try {
    const first = await request(server, 'stream', history(valid.slice(1)))
    const sent = toolIds(first)
    // Valid ids pass unchanged: the carrier turn's and the later Claude-shaped ones, each with its result.
    expect(sent.filter((id) => valid.includes(id))).toEqual([
      'call_1',
      'call_1',
      'toolu_01Valid',
      'call_valid-2',
      'toolu_01Valid',
      'call_valid-2',
    ])
    expect(sent.every((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id))).toBe(true)
    // Both carrier turns still replay their native signed thinking.
    expect(
      first.flatMap((frame) =>
        frame.message.content
          .filter((block) => block.type === 'thinking')
          .map((block) => block.signature),
      ),
    ).toEqual(['sig-native', 'sig-native'])

    // streamSimple sends the same frames.
    expect(await request(server, 'streamSimple', history(valid.slice(1)))).toEqual(first)

    // Later valid ids equal to ids generated for the invalid ones stay unchanged and still pair up distinctly.
    const generated = [...new Set(sent.filter((id) => !valid.includes(id)))]
    expect(generated).toHaveLength(5)
    const colliding = await request(server, 'stream', history(generated.slice(0, 2)))
    expect(toolIds(colliding).slice(-4)).toEqual([
      ...generated.slice(0, 2),
      ...generated.slice(0, 2),
    ])
  } finally {
    await server.close()
  }
  // After reopening, the same history maps to the same ids.
  server = await fauxServer(options)
  try {
    expect(await request(server, 'streamSimple', history(valid.slice(1)))).toEqual(
      (await sentFrames())[0],
    )
  } finally {
    await server.close()
  }
}, 60000)

for (const lifecycle of ['reload', 'reopen', 'swap', 'cancel', 'permanent'] as const) {
  it(`preserves Claude Code requests across ${lifecycle}`, async () => {
    const home = await temp()
    const cli = join(home, 'claude')
    const started = join(home, 'started')
    const release = join(home, 'release')
    const workers = join(home, 'workers')
    await writeFile(
      cli,
      `#!${process.execPath}
import { existsSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv.includes('status')) {
  console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'max' }))
} else {
  appendFileSync(${JSON.stringify(workers)}, process.pid + '\\n')
  const emit = (event) => console.log(JSON.stringify(event))
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type !== 'user') continue
    if (frame.shouldQuery === false) {
      emit({ type: 'result', subtype: 'success', num_turns: 0 })
      continue
    }
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Recovered.' } } })
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    appendFileSync(${JSON.stringify(started)}, 'request\\n')
    while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20))
    const message = { id: 'msg_test', role: 'assistant', content: [{ type: 'text', text: 'Recovered.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    emit({ type: 'assistant', message })
    emit({ type: 'stream_event', event: { type: 'message_stop' } })
    emit({ type: 'result', subtype: ${JSON.stringify(lifecycle)} === 'permanent' ? 'invalid_request' : 'success', is_error: ${JSON.stringify(lifecycle)} === 'permanent', usage: message.usage })
  }
}
`,
    )
    await chmod(cli, 0o755)
    vi.stubEnv('PI_CLAUDE_CODE_COMMAND', cli)
    const projectRoot = join(home, 'project')
    await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
    await writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      // A real (not faux) server: keep it off this machine's tailnet. Count only lifecycle requests, not summaries
      // falling back to the mocked Claude Code provider; an explicit unavailable summary model never falls back.
      JSON.stringify({ summaryModel: 'unavailable/test', extensions: { disable: ['tailscale'] } }),
    )
    new ProjectTrustStore(join(home, '.ultimate')).set(projectRoot, true)
    const root = await sourceCopy(home)
    const options = {
      ultimateRoot: root,
      projectRoot,
      home: join(home, 'state'),
      userHome: home,
      port: 0,
    }
    let server = await createServer(options)
    const messages = async () =>
      (await server.root.entries({}, 100, undefined, context)).items.flatMap(
        (entry) => entry.model ?? [],
      )
    const model = server.host.modelRuntime.getModel('claude-code', 'claude-sonnet-5')!
    if (!isModelType(model, 'chat')) throw new Error('Expected chat model')
    try {
      await server.root.configure(
        { model: { provider: 'claude-code', modelId: 'claude-sonnet-5' } },
        context,
      )
      await server.host.modelRuntime.refresh({ allowNetwork: false })
      expect(server.host.modelRuntime.getModel('claude-code', 'claude-sonnet-5')).toBeDefined()
      const submitted = await server.root.submit(
        { type: 'input', content: 'Wait for release.' },
        context,
      )
      await until(async () => {
        const terminal = (await messages()).find(
          (message) => message.role === 'assistant' && message.stopReason !== 'pending',
        )
        if (terminal) throw new Error(JSON.stringify(terminal))
        return !!(await readFile(started, 'utf8').catch(() => ''))
      })
      // A browser refresh disconnects its event subscription, not the durable run.
      const browser = await attach(server)
      // The CLI writing its marker does not mean the host has consumed its partial yet.
      await until(() => JSON.stringify(browser.view().docs['pi.live'] ?? {}).includes('Recovered.'))
      await browser.close()
      const reconnected = await attach(server)
      await reconnected.close()
      expect(
        (await post(server, '/api/extensions/claude-code/actions/status', { args: null })).status,
      ).toBe(200)
      expect((await messages()).filter((message) => message.role === 'assistant')).toHaveLength(0)
      let streamsShared = true
      let cancelStatus: number | undefined
      let cancelOutcome: unknown
      if (lifecycle === 'reload') {
        const provider = server.host.modelRuntime.getProvider('claude-code')
        const file = join(root, 'extensions/claude-code/server.ts')
        await writeFile(file, (await readFile(file, 'utf8')) + '\n')
        server.vite.watcher.emit('change', file)
        await until(() => server.host.modelRuntime.getProvider('claude-code') !== provider)
        const replacement = server.host.modelRuntime.getProvider('claude-code')!
        streamsShared =
          replacement.stream === provider?.stream &&
          replacement.streamSimple === provider?.streamSimple
      } else if (lifecycle === 'reopen' || lifecycle === 'swap') {
        // Supervised swaps release the harness before extension cleanup; ordinary
        // close does the reverse. Exercise both orders against the same durable home.
        if (lifecycle === 'swap') await server.release()
        await server.close()
        server = await createServer(options)
        await until(async () => (await readFile(started, 'utf8')).trim().split('\n').length === 2)
      } else if (lifecycle === 'cancel') {
        cancelStatus = (await post(server, '/api/conversations/1/abort')).status
        const outcome = await submitted.wait(context)
        cancelOutcome = {
          status: outcome.status,
          reason: 'reason' in outcome ? outcome.reason : undefined,
        }
      }
      await writeFile(release, 'ready')
      await server.harness.waitForIdle(context)
      const assistants = (await messages()).filter((message) => message.role === 'assistant')
      expect(streamsShared).toBe(true)
      expect(cancelStatus).toBe(lifecycle === 'cancel' ? 200 : undefined)
      expect(cancelOutcome).toEqual(
        lifecycle === 'cancel' ? { status: 'unanswered', reason: 'aborted' } : undefined,
      )
      expect(assistants.at(0)).toMatchObject({
        stopReason:
          lifecycle === 'cancel' ? 'aborted' : lifecycle === 'permanent' ? 'error' : 'stop',
        content: [{ type: 'text', text: 'Recovered.' }],
        ...(lifecycle === 'permanent'
          ? { errorMessage: 'Claude Code request failed: invalid_request' }
          : {}),
      })
      if (lifecycle === 'cancel' || lifecycle === 'permanent') {
        await server.close()
        server = await createServer(options)
        await server.harness.waitForIdle(context)
      }
      expect((await readFile(started, 'utf8')).trim().split('\n')).toHaveLength(
        lifecycle === 'reopen' || lifecycle === 'swap' ? 2 : 1,
      )
    } finally {
      const captured = server.host.modelRuntime.getProvider('claude-code')!
      await server.close()
      // Captured registrations must not start workers after resource cleanup began.
      expect(() => captured.streamSimple(model, normalizeContext({ messages: [] }))).toThrow(
        'provider is closing',
      )
      expect(() => captured.stream(model, normalizeContext({ messages: [] }))).toThrow(
        'provider is closing',
      )
      await until(async () =>
        (await readFile(workers, 'utf8'))
          .trim()
          .split('\n')
          .every((pid) => {
            try {
              process.kill(Number(pid), 0)
              return false
            } catch {
              return true
            }
          }),
      )
    }
  }, 60000)
}
