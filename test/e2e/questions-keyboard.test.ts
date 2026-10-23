// Answers a three-question card in a real browser with only the keyboard: letter keys choose, ↑/↓ move between
// questions, Enter sends; the reply reaches @ultimate in the message's own numbering.
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { chromium } from 'playwright-core'
import { afterEach, expect, it } from 'vitest'
import { Messages } from '../../extensions/messages/api.ts'
import { context } from '../../server/harness.ts'
import { fauxServer, post, removeTemp, temp, until } from '../helpers.ts'

const decisions =
  "The preview is ready.\n\nDecisions:\n1. **Branch starts in the context:** (a) one-line intent plus breadcrumb; (b) drop them, rely on abstracts; (c) leave as is.\n2. **Boxer's copied `agents/ultimate.md`:** (a) assess a way to add tools without forking it; (b) leave it.\n3. **Land it:** (a) yes; (b) no, change something first.\n\nMy picks: 1a 2a 3a."

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('answers a decisions card with letters, arrows and Enter', async () => {
  const home = await temp('ultimate-questions-keys-')
  cleanup.push(() => removeTemp(home))
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot: resolve('.'),
    userHome: home,
    home: join(home, 'state'),
    port: 0,
  })
  cleanup.push(() => server.close())
  // @ultimate asks the user the three decisions on each input, and acknowledges anything else.
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    return last.role === 'user' && last.content === 'ask'
      ? fauxAssistantMessage([fauxToolCall('message', { to: 'user', text: decisions })], {
          stopReason: 'toolUse',
        })
      : fauxAssistantMessage('Noted.')
  }
  server.host.faux!.setResponses([route])
  const { data } = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = data.result as ConversationId
  const conversation = (await server.harness.conversation(ultimate, context))!
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  const log = () => server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  const ask = async () => (await log())?.messages.findLast((m) => m.to === 'user' && m.reply)
  await until(async () => !!(await ask()))
  const asked = (await ask())!

  const browser = await chromium.launch({
    executablePath: process.env.ULTIMATE_CHROMIUM ?? '/usr/bin/google-chrome-stable',
    headless: true,
  })
  cleanup.push(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${server.url}/?conversation=${ultimate}`)
  const card = page.locator(`[data-questions-card="message:${asked.id}"]`)
  await card.locator('fieldset').nth(2).waitFor()
  // The composer takes focus on desktop and keeps its keys; the card takes them once the user leaves it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // Question 1: b; down to 2: a; down to 3: b; back up twice and change 1 to c.
  await page.keyboard.press('b')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('a')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('b')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('c')
  expect(await card.locator('[aria-pressed=true]').allTextContents()).toEqual([
    expect.stringContaining('leave as is'),
    expect.stringContaining('assess a way to add tools'),
    expect.stringContaining('no, change something first'),
  ])
  // Enter moves on to the last question, then sends.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const answer = async () =>
    (await log())?.messages.find((m) => m.re === asked.id && m.from === 'user')
  await until(async () => !!(await answer()))
  expect((await answer())!.text).toBe(
    "1c. Branch starts in the context: leave as is\n\n2a. Boxer's copied agents/ultimate.md: assess a way to add tools without forking it\n\n3b. Land it: no, change something first",
  )
  await card.waitFor({ state: 'detached' })
  // @ultimate's turn on the answer must end first: an ask submitted while it runs steers into that turn, which
  // then answers "Noted." instead of asking again.
  await until(async () => (await answer())!.state === 'answered')

  // A fresh card: Accept picks, then a single Enter sends.
  await (await conversation.submit({ type: 'input', content: 'ask' }, context)).wait(context)
  await until(async () => (await ask())!.id !== asked.id)
  const second = (await ask())!
  const next = page.locator(`[data-questions-card="message:${second.id}"]`)
  await next.locator('fieldset').nth(2).waitFor()
  await next.getByRole('button', { name: 'Accept picks' }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Enter')
  const picked = async () =>
    (await log())?.messages.find((m) => m.re === second.id && m.from === 'user')
  await until(async () => !!(await picked()))
  expect((await picked())!.text).toMatch(/^1a\. .+\n\n2a\. .+\n\n3a\. Land it: yes$/)
})
