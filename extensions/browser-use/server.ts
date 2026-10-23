import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

// The local browser-use service (systemd `browser-use.service`), driven by deepseek over CommandCode.
const ENDPOINT = process.env.BROWSER_USE_URL ?? 'http://127.0.0.1:4799'

interface RunResult {
  result: string
  success: boolean
  steps: number
  urls?: string[]
}

export default function browserUseExtension(_host: ExtensionHost) {
  return defineExtension({
    name: 'browser-use',
    sections: [
      section(
        'browser_use',
        () =>
          'Use browser_use to carry out a goal on the live web in a real headless browser: give it a plain-language task ("find the price of X on site Y", "log in and read the latest message") and it navigates, clicks and reads on its own, then reports what it found. It is slower than a single fetch, so prefer it when a task needs several steps or JavaScript-rendered pages. One run at a time.',
      ),
    ],
    tools: [
      defineTool({
        name: 'browser_use',
        description:
          'Carry out a multi-step goal on the live web in a real headless browser and report the result. Slower than a plain fetch; use it when a task needs navigation, clicks or JS-rendered content.',
        // Web interactions (clicks, form submits) are not safe to repeat after a crash.
        replay: 'unsafe',
        structuredOutputSchema: Type.Object({
          success: Type.Boolean(),
          steps: Type.Number(),
          urls: Type.Array(Type.String()),
          result: Type.String(),
        }),
        parameters: Type.Object({
          task: Type.String({ description: 'The goal to accomplish, in plain language.' }),
          max_steps: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 40, description: 'Step budget (default 12).' }),
          ),
          allowed_domains: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Restrict navigation to these domains, e.g. ["example.com"].',
            }),
          ),
          model: Type.Optional(
            Type.String({
              description: 'Override the driving model, e.g. commandcode deepseek id.',
            }),
          ),
        }),
        async execute(args, api, context) {
          api.output(`Running browser task: ${args.task}\n`)
          const response = await fetch(`${ENDPOINT}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args),
            signal: context.abortSignal,
          })
          if (!response.ok) {
            throw new Error(
              `browser-use service ${response.status}: ${(await response.text()).slice(0, 300)}`,
            )
          }
          const data = (await response.json()) as RunResult
          api.output(`Done in ${data.steps} steps (success=${data.success}).\n`)
          const result = {
            success: data.success,
            steps: data.steps,
            urls: data.urls ?? [],
            result: data.result,
          }
          return {
            output: [{ type: 'text', text: JSON.stringify(result) }],
            structuredOutput: result,
            isError: !data.success,
          }
        },
      }),
    ],
  })
}
