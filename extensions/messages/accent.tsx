/** A sender's quiet accent: a stripe on the side it writes from, a faint fill and the colour of its name. */
export type Accent = { left: string; fill: string; name: string }

const palette: readonly Accent[] = [
  {
    left: 'border-l-sky-500/60',
    fill: 'bg-sky-500/5',
    name: 'text-sky-700 dark:text-sky-300',
  },
  {
    left: 'border-l-emerald-500/60',
    fill: 'bg-emerald-500/5',
    name: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    left: 'border-l-teal-500/60',
    fill: 'bg-teal-500/5',
    name: 'text-teal-700 dark:text-teal-300',
  },
  {
    left: 'border-l-rose-500/60',
    fill: 'bg-rose-500/5',
    name: 'text-rose-700 dark:text-rose-300',
  },
  {
    left: 'border-l-orange-500/60',
    fill: 'bg-orange-500/5',
    name: 'text-orange-700 dark:text-orange-300',
  },
  {
    left: 'border-l-lime-500/60',
    fill: 'bg-lime-500/5',
    name: 'text-lime-700 dark:text-lime-300',
  },
]
const user: Accent = {
  left: 'border-l-brand/60',
  fill: 'bg-brand/5',
  name: 'text-brand',
}

/** Another project's Ultimate: a violet the conversation palette never uses. */
const remote: Accent = {
  left: 'border-l-violet-500/70',
  fill: 'bg-violet-500/10',
  name: 'text-violet-700 dark:text-violet-300',
}

/** A stable palette slot for a sender other than the user. */
export function accentIndex(id: number, size: number) {
  let hash = 0
  for (const char of `#${id}`) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return (hash >>> 0) % size
}

/**
 * The accent of a sender: the user always has the brand colour, another project's Ultimate violet, a conversation a
 * stable slot of a small palette.
 */
export const accentOf = (id: number | 'user' | 'remote'): Accent =>
  id === 'user' ? user : id === 'remote' ? remote : palette[accentIndex(id, palette.length)]
