import { expect, it } from 'vitest'
import { extensionOptions } from '../../extensions/onboarding/choices.tsx'

const core = ['subagents', 'messages', 'lineage', 'onboarding', 'documents']

it('keeps every core-tier extension checked and locked, even over saved or pending disables', () => {
  const changed = Object.fromEntries(core.map((name) => [name, false]))
  const options = extensionOptions([...core, 'parallel'], { ...changed, info: false }, core)
  expect(options.filter((entry) => entry.required).map((entry) => entry.name)).toEqual([
    'subagents',
    'messages',
    'lineage',
    'onboarding',
    'documents',
  ])
  for (const name of core) {
    expect(options.find((entry) => entry.name === name)).toMatchObject({
      checked: true,
      required: true,
      hint: 'core, always on',
    })
  }
  expect(options.find((entry) => entry.name === 'parallel')).toMatchObject({
    checked: false,
    required: false,
  })
  expect(options.find((entry) => entry.name === 'info')).toMatchObject({
    checked: false,
    required: false,
  })
  expect(
    extensionOptions(['parallel'], { parallel: true }, core).find(
      (entry) => entry.name === 'parallel',
    ),
  ).toMatchObject({ checked: true, required: false })
})
