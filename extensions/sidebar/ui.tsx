/** The sidebar's points for other extensions' browser code. */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

/** Rows nested under @ultimate's row (`side-chat` lists its open side chats); input is @ultimate's conversation id. */
export const UnderUltimate = definePoint<number | undefined, ReactNode>('sidebar.under-ultimate')
