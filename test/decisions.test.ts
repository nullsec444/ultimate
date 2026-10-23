import { describe, expect, it } from 'vitest'
import { parseDecisions } from '../lib/decisions.ts'
import { gist } from '../extensions/messages/server.ts'
import { answerText, decisionQuestions } from '../extensions/questions/server.ts'

// #97078 message 1326, the reported card that offered only a free-text field.
const m1326 = `**Branch prompts in boxer's project context:** I read boxer's root (#1) from here.

**My take:** you're right, they don't belong there in full.
- **Already covered:** each branch's abstract already opens with an "Ask:" line.

Decisions (my picks: 1a 2a):
1. **Branch starts in the context:** (a) one-line intent plus breadcrumb; (b) drop them, rely on abstracts; (c) leave as is.
2. **Boxer's copied \`agents/ultimate.md\`:** (a) assess a way for projects to add tools to @ultimate without forking it; (b) leave it.`

// #97078 message 1335: a numbered findings list before the decisions block, picks on their own line.
const m1335 = `**The main cause is my message format, not the card.**
1. **Stated picks read as decided.** The prompt says to leave out "anything already decided".
2. **Extra questions:** a trailing "go" or "Build it?" turned into an extra question.

Decisions:
1. **Scope:** (a) the full recommendation; (b) the easier alternative.
2. **Keyboard browser test:** (a) add one that answers a 3-question card with the keyboard; (b) fast tests only.
3. **Answer format:** (a) \`1a. Topic: label\` lines; (b) keep \`Q:/A:\`.

My picks: 1a 2a 3a.`

describe('the decisions block', () => {
  it('reads lettered options and stated picks (#97078 message 1326)', () => {
    expect(parseDecisions(m1326)).toEqual([
      {
        ref: '1',
        topic: 'Branch starts in the context',
        options: [
          { key: 'a', label: 'one-line intent plus breadcrumb', recommended: true },
          { key: 'b', label: 'drop them, rely on abstracts' },
          { key: 'c', label: 'leave as is' },
        ],
      },
      {
        ref: '2',
        topic: "Boxer's copied agents/ultimate.md",
        options: [
          {
            key: 'a',
            label: 'assess a way for projects to add tools to @ultimate without forking it',
            recommended: true,
          },
          { key: 'b', label: 'leave it' },
        ],
      },
    ])
  })

  it('takes the last block and ignores numbered findings before it (#97078 message 1335)', () => {
    const decisions = parseDecisions(m1335)
    expect(decisions.map((d) => d.topic)).toEqual([
      'Scope',
      'Keyboard browser test',
      'Answer format',
    ])
    expect(decisions.every((d) => d.options[0].recommended && !d.options[1].recommended)).toBe(true)
    // A colon inside inline code is not a label split.
    expect(decisions[2].options[0]).toEqual({
      key: 'a',
      label: '1a. Topic: label lines',
      recommended: true,
    })
  })

  it('keeps an out-of-sequence letter inside the option that mentions it', () => {
    const [scope] = parseDecisions(
      '1. **Scope:** (a) ports and teardown; (b) onboarding only; (c) (a) without teardown.\nMy picks: 1c.',
    )
    expect(scope.options.map((o) => o.label)).toEqual([
      'ports and teardown',
      'onboarding only',
      '(a) without teardown',
    ])
    expect(scope.options[2].recommended).toBe(true)
  })

  it('marks "(recommended)" and reads picks phrased in prose', () => {
    const [first, second] = parseDecisions(
      'Decisions (my picks are 1b, 2a, go):\n1. **A:** (a) one; (b) two (recommended).\n2. **B:** (a) yes; (b) no.',
    )
    expect(first.options.map((o) => [o.label, !!o.recommended])).toEqual([
      ['one', false],
      ['two', true],
    ])
    expect(second.options[0].recommended).toBe(true)
  })

  it('never lets an earlier lettered report stand in for a closing question', () => {
    expect(
      parseDecisions(
        'Checks completed:\n1. Verified: (a) unit tests pass; (b) build passes.\n\nLand it?\n1. Yes\n2. Change something first',
      ),
    ).toEqual([])
  })

  it('keeps option labels whole when shortening them would repeat one', () => {
    const [keep] = parseDecisions('1. **Keep:** (a) Keep: summaries only; (b) Keep: full history.')
    expect(keep.options.map((o) => o.label)).toEqual(['Keep: summaries only', 'Keep: full history'])
    // Compared after inline code loses its backticks.
    const [code] = parseDecisions(
      '1. **Keep:** (a) `Keep`: summaries only; (b) Keep: full history.',
    )
    expect(code.options.map((o) => o.label)).toEqual(['Keep: summaries only', 'Keep: full history'])
    // Identical options leave one, so a choice never maps to another option's letter.
    expect(parseDecisions('1. **Mode:** (a) Keep; (b) Keep.')).toEqual([])
    const [mode] = parseDecisions('1. **Mode:** (a) Keep; (b) Keep; (c) Drop.')
    expect(mode.options.map((o) => [o.key, o.label])).toEqual([
      ['a', 'Keep'],
      ['c', 'Drop'],
    ])
  })

  it('answers b with b when labels were made distinct', () => {
    const questions = decisionQuestions(
      '1. **Keep:** (a) Keep: summaries only; (b) Keep: full history.',
    )
    expect(
      answerText([{ question: 'Keep', answer: questions[0].options![1].label }], questions),
    ).toBe('1b. Keep: Keep: full history')
  })

  it('finds no decisions in plain numbered options, prose or reports', () => {
    expect(parseDecisions('Land it?\n1. Yes\n2. Change something first')).toEqual([])
    expect(parseDecisions('Landed `abc1234`. Nothing to decide.')).toEqual([])
    expect(parseDecisions('Steps:\n1. Read (a) the code.\n2. Run it.')).toEqual([])
  })
})

describe('questions from a decisions block', () => {
  const questions = decisionQuestions(m1326)

  it('become choices that keep the message numbering and picks', () => {
    expect(questions.map((q) => [q.ref, q.kind, q.options!.map((o) => o.key).join('')])).toEqual([
      ['1', 'choice', 'abc'],
      ['2', 'choice', 'ab'],
    ])
  })

  it('answer in the message numbering, with typed text as "n: text"', () => {
    expect(
      answerText(
        [
          { question: questions[0].text, answer: 'one-line intent plus breadcrumb' },
          { question: questions[1].text, answer: 'only for @ultimate, not reviewers' },
        ],
        questions,
      ),
    ).toBe(
      '1a. Branch starts in the context: one-line intent plus breadcrumb\n\n2: only for @ultimate, not reviewers',
    )
  })

  it('answer extracted questions without numbering by their text', () => {
    expect(
      answerText(
        [{ question: 'Land it?', answer: 'Yes' }],
        [{ text: 'Land it?', kind: 'confirm' }],
      ),
    ).toBe('Land it?: Yes')
  })

  it('name a message by its decisions in the open-questions note', () => {
    expect(gist(m1335)).toBe('decisions 1. Scope; 2. Keyboard browser test; 3. Answer format')
    expect(gist('Done.\n\nShould I submit it?')).toBe('Should I submit it?')
  })
})
