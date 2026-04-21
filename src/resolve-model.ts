import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';
import { getModels, getProviders } from '@mariozechner/pi-ai';

/**
 * Failure resolving `LLM_PROVIDER` / `LLM_MODEL` against pi-ai's registry.
 * The message always names what the user typed plus what was valid, so the
 * operator never has to go spelunking in pi-ai source to find the right id.
 */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

/**
 * Look up a pi-ai Model by runtime `provider` and `modelId` strings.
 *
 * pi-ai's own `getModel(provider, modelId)` is generic with literal-type
 * constraints — useful when both values are known at compile time, but at
 * odds with values that arrive from env vars. This wrapper does the lookup
 * via the runtime catalogues (`getProviders()` / `getModels()`) and throws a
 * `ModelResolutionError` with a helpful message when either is unknown. It
 * concentrates the one necessary `as KnownProvider` cast into a single spot
 * that is guarded by an immediately-preceding `includes` check.
 */
export function resolveModel(provider: string, modelId: string): Model<Api> {
  const providers = getProviders();
  if (!providers.includes(provider as KnownProvider)) {
    throw new ModelResolutionError(
      `Unknown LLM provider "${provider}". Known providers: ${providers.join(', ')}.`,
    );
  }
  const models = getModels(provider as KnownProvider);
  const match = models.find(m => m.id === modelId);
  if (!match) {
    throw new ModelResolutionError(
      `Unknown model "${modelId}" for provider "${provider}". Available models: ${models
        .map(m => m.id)
        .join(', ')}.`,
    );
  }
  return match;
}
