import { defineWebExtension, provide } from '@/sdk'
import { MessageAnswers } from '../messages/ui.tsx'
import { MessageQuestions } from './card.tsx'

export default defineWebExtension({
  entries: {
    // Retired cards have no interaction; hide them instead of exposing their raw JSON.
    'questions.asked': () => null,
    'questions.answers': () => null,
  },
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('todos'),
    },
  ],
  provides: [provide(MessageAnswers, (message) => <MessageQuestions message={message} />)],
})
