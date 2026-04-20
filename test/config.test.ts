import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const completeEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  LLM_MODEL: 'claude-haiku-4-5',
  LLM_PROVIDER: 'anthropic',
  OVERSEERR_API_KEY: 'over-test',
  OVERSEERR_URL: 'http://overseerr:5055',
  OWNER_TELEGRAM_USER_ID: '12345',
  TELEGRAM_BOT_TOKEN: 'tg-test',
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
      'TELEGRAM_BOT_TOKEN',
      'OVERSEERR_URL',
      'OVERSEERR_API_KEY',
      'OWNER_TELEGRAM_USER_ID',
      'LLM_PROVIDER',
      'LLM_MODEL',
    ];
    for (const name of requiredVars) {
      expect(() => loadConfig({})).toThrow(name);
    }
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
});
