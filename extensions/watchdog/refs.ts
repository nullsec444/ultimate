/** Watchdog failure cards: the failed conversation, error, last step and retry outcome. */
export type Failure = {
  conversation: number
  title: string
  error: string
  step: string
  hint?: string
  retried: boolean
}
