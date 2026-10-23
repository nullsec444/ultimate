import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { isModelType } from '@earendil-works/pi-ai/models'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ModelsResponse } from '../shared/protocol.ts'

export async function listModels(runtime: ModelRuntime): Promise<ModelsResponse> {
  const available = new Set(
    (await runtime.getAvailable()).map((model) => `${model.provider}/${model.id}`),
  )
  return {
    providers: runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.auth.oauth?.name ?? provider.auth.apiKey?.name ?? provider.id,
      authTypes: [
        ...(provider.auth.apiKey?.login
          ? [{ type: 'api_key' as const, name: provider.auth.apiKey.name }]
          : []),
        ...(provider.auth.oauth?.login
          ? [{ type: 'oauth' as const, name: provider.auth.oauth.name }]
          : []),
      ],
      status: runtime.getProviderAuthStatus(provider.id),
      isUsingSubscription: runtime.isUsingSubscription(provider.id),
    })),
    models: runtime
      .getAllModels()
      .filter((model) => isModelType(model, 'chat'))
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model),
        cost: model.cost,
        available: available.has(`${model.provider}/${model.id}`),
      })),
  }
}
