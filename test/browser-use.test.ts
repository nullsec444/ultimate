import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { NestedToolExecutionResult } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import browserUse from '../extensions/browser-use/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

afterEach(() => vi.unstubAllGlobals())

it.each([true, false])(
  'delivers the browser result through Pi to nested tools (success=%s)',
  async (success) => {
    const home = await temp('ultimate-browser-use-')
    const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home, faux: true })
    const result = { success, steps: 2, urls: ['https://example.com/'], result: 'Example Domain' }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(result)))
    const extension = browserUse({} as ExtensionHost)
    expect(extension.tools![0].replay).toBe('unsafe')
    prepared.registry.install(extension)
    let nested: NestedToolExecutionResult | undefined
    prepared.registry.install(
      defineExtension({
        name: 'browser-probe',
        tools: [
          defineTool({
            name: 'browser_probe',
            description: 'Read a browser result through the harness',
            parameters: Type.Object({}),
            async execute(_args, api, ctx) {
              nested = await api.executeTool('browser_use', { task: 'Read the page title' }, ctx)
              return { output: [{ type: 'text', text: JSON.stringify(nested.structuredOutput) }] }
            },
          }),
        ],
      }),
    )
    prepared.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('browser_probe', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Complete'),
    ])
    const opened = await prepared.open()
    try {
      await (
        await opened.root.submit({ type: 'input', content: 'Read the title' }, context)
      ).wait(context)
      expect(nested?.structuredOutput).toEqual(result)
      expect(nested?.isError).toBe(!success)
      const view = await opened.root.viewState(context)
      try {
        const outputs = view.value.entries.filter((entry) => entry.kind === 'pi.tool-result')
        expect(JSON.stringify(outputs)).toContain('Example Domain')
      } finally {
        view.dispose()
      }
    } finally {
      await opened.close()
    }
  },
)
