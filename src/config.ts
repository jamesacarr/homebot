import { z } from 'zod';

const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

const configSchema = z.object({
  dailyCostCapUsd: z.coerce.number().positive().default(1.0),
  dbPath: z.string().min(1).default('/data/homebot.db'),
  llmModel: z.string().min(1),
  llmProvider: z.string().min(1),
  llmThinkingLevel: z.enum(THINKING_LEVELS).default('off'),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  maxTurnsInHistory: z.coerce.number().int().positive().default(15),
  overseerrApiKey: z.string().min(1),
  overseerrUrl: z.string().url(),
  ownerTelegramUserId: z.coerce.number().int().positive(),
  telegramBotToken: z.string().min(1),
});

export type Config = z.infer<typeof configSchema>;

const ENV_VAR_BY_KEY: Record<keyof Config, string> = {
  dailyCostCapUsd: 'DAILY_COST_CAP_USD',
  dbPath: 'DB_PATH',
  llmModel: 'LLM_MODEL',
  llmProvider: 'LLM_PROVIDER',
  llmThinkingLevel: 'LLM_THINKING_LEVEL',
  logLevel: 'LOG_LEVEL',
  maxTurnsInHistory: 'MAX_TURNS_IN_HISTORY',
  overseerrApiKey: 'OVERSEERR_API_KEY',
  overseerrUrl: 'OVERSEERR_URL',
  ownerTelegramUserId: 'OWNER_TELEGRAM_USER_ID',
  telegramBotToken: 'TELEGRAM_BOT_TOKEN',
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = {
    dailyCostCapUsd: env.DAILY_COST_CAP_USD,
    dbPath: env.DB_PATH,
    llmModel: env.LLM_MODEL,
    llmProvider: env.LLM_PROVIDER,
    llmThinkingLevel: env.LLM_THINKING_LEVEL,
    logLevel: env.LOG_LEVEL,
    maxTurnsInHistory: env.MAX_TURNS_IN_HISTORY,
    overseerrApiKey: env.OVERSEERR_API_KEY,
    overseerrUrl: env.OVERSEERR_URL,
    ownerTelegramUserId: env.OWNER_TELEGRAM_USER_ID,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  };

  const result = configSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const lines = result.error.issues.map(issue => {
    const key = issue.path[0] as keyof Config | undefined;
    const envVar = key ? ENV_VAR_BY_KEY[key] : '(unknown)';
    return `  - ${envVar}: ${issue.message}`;
  });
  throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
}
