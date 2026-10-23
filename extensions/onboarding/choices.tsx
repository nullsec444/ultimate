export const recommended: readonly { name: string; line: string; needs?: string }[] = [
  { name: 'subagents', line: 'Hands bounded work to helper agents' },
  { name: 'messages', line: 'Talk to @ultimate and the project team' },
  { name: 'lineage', line: 'Roots, branches and the project context' },
  { name: 'onboarding', line: 'Setup cards and extension choices' },
  { name: 'plan', line: 'Durable epics and tasks for long work' },
  { name: 'automations', line: 'Prompts that run on a schedule', needs: 'subagents' },
  { name: 'documents', line: 'Extension state in the right panel' },
  { name: 'tasks', line: 'What runs right now, live' },
  { name: 'info', line: 'Machine, code, and extensions at a glance' },
  { name: 'parallel', line: 'Web search and fetch (parallel.ai)', needs: 'secrets' },
]

/** The recommended switches; the `core` tier extensions are always on, so their boxes stay checked and locked. */
export function extensionOptions(
  disabled: readonly string[],
  changed: Record<string, boolean>,
  core: readonly string[],
) {
  return recommended.map((entry) => {
    const required = core.includes(entry.name)
    return {
      ...entry,
      required,
      checked: required || (changed[entry.name] ?? !disabled.includes(entry.name)),
      hint: required ? 'core, always on' : entry.needs ? `needs ${entry.needs}` : undefined,
    }
  })
}
