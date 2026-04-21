import { getModels, getProviders } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';

import { ModelResolutionError, resolveModel } from '../src/resolve-model.js';

// Pick a real built-in provider + one of its models. `resolveModel` uses
// pi-ai's static registry (`getProviders`/`getModels`), which doesn't include
// dynamically-registered faux providers — tests must go through the same
// registry the production code will.
const BUILT_IN_PROVIDER = 'anthropic';

describe('resolveModel', () => {
  it('returns the Model when the provider and id both exist in the pi-ai registry', () => {
    // Pick any model id the registry advertises for this provider so the
    // test stays resilient to pi-ai's generated catalogue churn.
    const anyModelId = getModels(BUILT_IN_PROVIDER)[0]?.id;
    if (anyModelId === undefined) {
      throw new Error(
        `Test assumption violated: pi-ai reports no ${BUILT_IN_PROVIDER} models`,
      );
    }
    const model = resolveModel(BUILT_IN_PROVIDER, anyModelId);
    expect(model.id).toBe(anyModelId);
    expect(model.provider).toBe(BUILT_IN_PROVIDER);
  });

  it('throws ModelResolutionError with the provider list when the provider is unknown', () => {
    let caught: unknown;
    try {
      resolveModel('not-a-real-provider', 'whatever');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelResolutionError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/not-a-real-provider/);
    // Error message must list the real providers so the operator can fix
    // their env var without reading pi-ai source.
    for (const p of getProviders()) {
      expect(msg).toContain(p);
    }
  });

  it('throws ModelResolutionError naming the available model ids when the id is unknown', () => {
    const someRealId = getModels(BUILT_IN_PROVIDER)[0]?.id;
    if (someRealId === undefined) {
      throw new Error(
        `Test assumption violated: pi-ai reports no ${BUILT_IN_PROVIDER} models`,
      );
    }
    let caught: unknown;
    try {
      resolveModel(BUILT_IN_PROVIDER, 'nonexistent-model-id');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelResolutionError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/nonexistent-model-id/);
    expect(msg).toContain(someRealId);
  });
});
