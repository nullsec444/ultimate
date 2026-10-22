/** Fast mode in the browser: which OpenAI models run in fast mode, and the action that toggles one. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** The fast models (`openai-codex/<id>` or `openai/<id>`), and whether the project's settings decide them. */
export type FastStatus = { models: string[]; project: boolean }

/** No arguments → the fast models and whether the project's settings decide them. */
export const StatusAction = actionRef<null, FastStatus>('fast', 'status')
/**
 * `{ model, on }` → the new status: add `model` to the user's `fastModels` or remove it. Refuses while the project's
 * settings decide the list.
 */
export const SetAction = actionRef<{ model: string; on: boolean }, FastStatus>('fast', 'set')
