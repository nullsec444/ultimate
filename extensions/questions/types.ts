/**
 * One extracted question. `ref` is the number the message gave it ("2"), and an option's `key` its letter ("a"), so an
 * answer can name them; both are absent when the message numbered nothing.
 */
export type Question = {
  text: string
  kind: 'confirm' | 'choice'
  ref?: string
  options?: { label: string; detail?: string; recommended?: boolean; key?: string }[]
}
/** The root's `questions.board` document: extracted questions by message id. */
export type MessageQuestionsData = {
  requested: number[]
  asked: Record<string, Question[]>
}
