// The minimal fork has no self extension. Supply a test-only caller of the core swap API so supervisor
// replay, failed preparation and activation rollback remain covered without restoring that extension.
export const restartFixture = `
import { awaitWithContext } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
export default (host) => defineExtension({
  name: 'test-restart',
  tools: [defineTool({
    name: 'restart', description: 'Exercise a supervised test swap', parameters: Type.Object({}),
    replay: 'safe',
    async execute(_args, api, context) {
      const key = 'restart:' + api.taskId
      const done = await api.memo(key, context)
      const generation = Number(process.env.ULTIMATE_GENERATION ?? 1)
      if (done) {
        const rolledBack = generation !== done.generation
        const error = host.system().process.activationError ?? 'Activation failed'
        return {
          ...(rolledBack && { isError: true }),
          details: {
            fromGeneration: done.fromGeneration, toGeneration: generation,
            fromBuild: done.build, toBuild: host.build().id,
            ...(rolledBack && { rolledBack: true, error }),
          },
          output: [{ type: 'text', text: rolledBack
            ? 'Restart failed during activation; rolled back to generation ' + generation + '. ' + error
            : 'Restarted. Now running generation ' + generation + ' (pid ' + process.pid + '), build ' + done.build + ' → ' + host.build().id + '.' }],
        }
      }
      const error = await awaitWithContext(host.restart(async (next) => {
        await api.memo(key, { generation: next, fromGeneration: generation, build: host.build().id }, context)
      }), context)
      return { isError: true, output: [{ type: 'text', text: error }] }
    },
  })],
})
`
