import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const completeEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  LLM_MODEL: 'claude-haiku-4-5',
  LLM_PROVIDER: 'anthropic',
  OVERSEERR_API_KEY: 'over-test',
  OVERSEERR_URL: 'http://overseerr:5055',
  TELEGRAM_BOT_TOKEN: 'tg-test',
  TELEGRAM_OWNER_ID: '12345',
};

describe('loadConfig', () => {
  it('returns a parsed config from a complete valid env', () => {
    const config = loadConfig(completeEnv);

    expect(config).toEqual({
      dailyCostCapUsd: 1.0,
      dbPath: '/data/homebot.db',
      llmModel: 'claude-haiku-4-5',
      llmProvider: 'anthropic',
      llmThinkingLevel: 'off',
      logLevel: 'info',
      maxTurnsInHistory: 15,
      overseerrApiKey: 'over-test',
      overseerrUrl: 'http://overseerr:5055',
      ownerTelegramUserId: 12345,
      telegramBotToken: 'tg-test',
    });
  });

  it('throws listing every missing required field by env var name', () => {
    const requiredVars = [
      'OVERSEERR_URL',
      'OVERSEERR_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_OWNER_ID',
      'LLM_PROVIDER',
      'LLM_MODEL',
    ];
    for (const name of requiredVars) {
      expect(() => loadConfig({})).toThrow(name);
    }
  });

  it('reports missing required fields as "Required", not as a coercion artefact', () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues;
    expect(issues.find(i => i.envVar === 'TELEGRAM_OWNER_ID')?.message).toBe(
      'Required',
    );
    expect(issues.find(i => i.envVar === 'TELEGRAM_BOT_TOKEN')?.message).toBe(
      'Required',
    );
  });

  it('treats an empty string as missing, not as a malformed value', () => {
    expect(() =>
      loadConfig({ ...completeEnv, TELEGRAM_BOT_TOKEN: '' }),
    ).toThrow(/TELEGRAM_BOT_TOKEN.*Required/s);
  });

  it('exposes issues as a structured list on the thrown ConfigError', () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(
      issues.every(
        i => typeof i.envVar === 'string' && typeof i.message === 'string',
      ),
    ).toBe(true);
  });

  it('applies supplied values for optional fields', () => {
    const config = loadConfig({
      ...completeEnv,
      DAILY_COST_CAP_USD: '0.25',
      DB_PATH: '/tmp/custom.db',
      LLM_THINKING_LEVEL: 'medium',
      LOG_LEVEL: 'debug',
      MAX_TURNS_IN_HISTORY: '20',
    });

    expect(config.dailyCostCapUsd).toBe(0.25);
    expect(config.dbPath).toBe('/tmp/custom.db');
    expect(config.llmThinkingLevel).toBe('medium');
    expect(config.logLevel).toBe('debug');
    expect(config.maxTurnsInHistory).toBe(20);
  });

  it('rejects an OVERSEERR_URL that is not a URL', () => {
    expect(() =>
      loadConfig({ ...completeEnv, OVERSEERR_URL: 'not-a-url' }),
    ).toThrow('OVERSEERR_URL');
  });

  it('throws when the configured LLM provider has no API key env var set', () => {
    const { ANTHROPIC_API_KEY: _unused, ...envMissingKey } = completeEnv;

    expect(() => loadConfig(envMissingKey)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('accepts ANTHROPIC_OAUTH_TOKEN as an alternative to ANTHROPIC_API_KEY', () => {
    const { ANTHROPIC_API_KEY: _unused, ...envWithoutApiKey } = completeEnv;

    expect(() =>
      loadConfig({
        ...envWithoutApiKey,
        ANTHROPIC_OAUTH_TOKEN: 'oat-test',
      }),
    ).not.toThrow();
  });

  it('includes the provider name in the missing-credential error message', () => {
    const { ANTHROPIC_API_KEY: _unused, ...envMissingKey } = completeEnv;
    let caught: unknown;
    try {
      loadConfig(envMissingKey);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const issue = (caught as ConfigError).issues.find(
      i => i.envVar === 'ANTHROPIC_API_KEY',
    );
    expect(issue?.message).toMatch(/anthropic/);
  });

  it('fails on missing OPENAI_API_KEY when the provider is openai', () => {
    expect(() =>
      loadConfig({
        ...completeEnv,
        ANTHROPIC_API_KEY: undefined,
        LLM_PROVIDER: 'openai',
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });
});
