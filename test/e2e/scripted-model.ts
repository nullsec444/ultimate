// A scripted model for spawned Ultimates: an OpenAI-compatible endpoint in the test process, registered as an ordinary
// provider through a Pi agent directory (`models.json`, `settings.json`) that the child gets as PI_CODING_AGENT_DIR.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The conversation as the endpoint sees it: the last message's role and text. */
export type Turn = { role: string; text: string }
/** The next answer: text, optionally followed by one tool call. */
export type Answer = { text?: string; tool?: { name: string; args: unknown } }

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? '').join('')
      : ''

/** One streamed chat-completion chunk. */
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'scripted',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted-1',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

/** Serve `answer` as the default model of a fresh Pi agent directory; `env` is what a child needs to use it. */
export async function scriptedModel(answer: (last: Turn) => Answer) {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (data) => (body += data))
    request.on('end', () => {
      const { messages } = JSON.parse(body) as { messages: { role: string; content: unknown }[] }
      const last = messages.at(-1)!
      const { text, tool } = answer({ role: last.role, text: textOf(last.content) })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (text) response.write(chunk({ role: 'assistant', content: text }))
      if (tool)
        response.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now()}`,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.args) },
              },
            ],
          }),
        )
      response.write(chunk({}, tool ? 'tool_calls' : 'stop'))
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  const { port } = server.address() as AddressInfo
  const agentDir = await mkdtemp(join(tmpdir(), 'ultimate-scripted-pi-'))
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'scripted',
          models: [{ id: 'scripted-1' }],
        },
      },
    }),
  )
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'scripted', defaultModel: 'scripted-1' }),
  )
  return {
    env: { PI_CODING_AGENT_DIR: agentDir },
    close: async () => {
      await new Promise<void>((closed) => server.close(() => closed()))
      await rm(agentDir, { recursive: true, force: true })
    },
  }
}
