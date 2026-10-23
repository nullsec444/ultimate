import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'
import type { Message } from './refs.ts'

/** What shows under a message to the user (`questions` provides its answer card). */
export const MessageAnswers = definePoint<Message, ReactNode>('messages.answers')
