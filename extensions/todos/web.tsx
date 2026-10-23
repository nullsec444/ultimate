import { ListTodoIcon } from 'lucide-react'
import { defineWebExtension } from '@/sdk'
import { Todos } from './panel.tsx'

export default defineWebExtension({
  // @ultimate's changed-list reminder is model context, not something to read in the transcript.
  entries: { 'todos.note': () => null },
  panels: [{ id: 'todos', title: 'To-dos', icon: ListTodoIcon, component: Todos, order: 0 }],
  commands: [
    {
      id: 'todos.open',
      title: 'Show to-dos',
      run: (context) => context.openPanel('todos'),
    },
  ],
})
