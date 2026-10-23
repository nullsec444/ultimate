/** Side chats for other extensions' browser code: opening one on @ultimate, its index, and which one is in front. */
import { useUiState } from '@/sdk'

export { OpenAction, SideChatsDoc } from './refs.ts'

/** The side chat in front of main, by id; durable UI state, so a reload brings the depth view back. */
export const useSideChatFront = () => useUiState<number | null>('ext.side-chat.front', null)
