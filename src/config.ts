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

const REQUIRED_ENV_VARS = [
  'LLM_PROVIDER',
  'LLM_MODEL',
  'OVERSEERR_URL',
  'OVERSEERR_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_ID',
] as const;

/**
 * Map of LLM provider id → list of env vars whose presence (any one)
 * satisfies pi-ai's credential lookup. Mirrors pi-ai's `getEnvApiKey`
 * mapping for the straightforward providers; providers with complex
 * multi-var auth (google-vertex, amazon-bedrock, github-copilot) are
 * intentionally omitted so we don't duplicate pi-ai's fallback logic
 * — for those, pi-ai's own runtime error remains the source of truth.
 *
 * The first entry is the "primary" env var we reference in error
 * messages. Fail-fasting here closes a hole where the bot would pass
 * startup sanity checks cleanly and then crash on the first user
 * message with `No API key for provider: <name>`.
 */
const PROVIDER_CREDENTIAL_ENV_VARS: Readonly<
  Record<string, readonly string[]>
> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  google: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  huggingface: ['HF_TOKEN'],
  mistral: ['MISTRAL_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  xai: ['XAI_API_KEY'],
  zai: ['ZAI_API_KEY'],
};

// Schema runs AFTER required-presence checks in loadConfig, so every field
// here is parsed against a known-non-empty input. Defaults apply to optional
// fields whose env var is absent.
const configSchema = z.object({
  dailyCostCapUsd: z.coerce.number().positive().default(1.0),
  dbPath: z.string().min(1).default('/data/homebot.db'),
  llmModel: z.string().min(1),
  llmProvider: z.string().min(1),
  llmThinkingLevel: z.enum(THINKING_LEVELS).default('off'),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  maxTurnsInHistory: z.coerce.number().int().positive().default(15),
  overseerrApiKey: z.string().min(1),
  overseerrUrl: z.url(),
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
  ownerTelegramUserId: 'TELEGRAM_OWNER_ID',
  telegramBotToken: 'TELEGRAM_BOT_TOKEN',
};

export interface ConfigIssue {
  envVar: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: ConfigIssue[]) {
    const formatted = issues
      .map(i => `  - ${i.envVar}: ${i.message}`)
      .join('\n');
    super(`Invalid configuration:\n${formatted}`);
    this.name = 'ConfigError';
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = {
    dailyCostCapUsd: emptyToUndefined(env.DAILY_COST_CAP_USD),
    dbPath: emptyToUndefined(env.DB_PATH),
    llmModel: emptyToUndefined(env.LLM_MODEL),
    llmProvider: emptyToUndefined(env.LLM_PROVIDER),
    llmThinkingLevel: emptyToUndefined(env.LLM_THINKING_LEVEL),
    logLevel: emptyToUndefined(env.LOG_LEVEL),
    maxTurnsInHistory: emptyToUndefined(env.MAX_TURNS_IN_HISTORY),
    overseerrApiKey: emptyToUndefined(env.OVERSEERR_API_KEY),
    overseerrUrl: emptyToUndefined(env.OVERSEERR_URL),
    ownerTelegramUserId: emptyToUndefined(env.TELEGRAM_OWNER_ID),
    telegramBotToken: emptyToUndefined(env.TELEGRAM_BOT_TOKEN),
  };

  // First pass: check required env vars explicitly, so missing fields produce
  // a clean "Required" message instead of zod's coercion fallback noise
  // (e.g. "expected number, received NaN" for a missing numeric).
  const issues: ConfigIssue[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    if (env[name] === undefined || env[name].trim() === '') {
      issues.push({ envVar: name, message: 'Required' });
    }
  }

  // Second pass: let zod validate formats on everything present.
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path[0] as keyof Config | undefined;
      const envVar = key ? ENV_VAR_BY_KEY[key] : '(unknown)';
      // Skip format errors for values we already flagged as Required — avoids
      // double-reporting the same variable.
      if (issues.some(i => i.envVar === envVar)) {
        continue;
      }
      issues.push({ envVar, message: issue.message });
    }
  }

  // Third pass: the configured provider must have its credential env var
  // present. Without this check the bot would pass every startup sanity
  // check and then surface `No API key for provider: <name>` on the
  // first user message — a fail-late pattern that hides misconfiguration
  // behind a seemingly-healthy deployment.
  if (result.success) {
    const provider = result.data.llmProvider;
    const candidates = PROVIDER_CREDENTIAL_ENV_VARS[provider];
    if (candidates && !candidates.some(name => !!emptyToUndefined(env[name]))) {
      const [primary, ...alternatives] = candidates;
      const hint =
        alternatives.length > 0 ? ` (or ${alternatives.join(', ')})` : '';
      issues.push({
        envVar: primary ?? 'UNKNOWN',
        message: `No API key for LLM provider '${provider}'. Set ${primary}${hint}.`,
      });
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }
  if (!result.success) {
    // Unreachable: safeParse failed but produced no issues we kept.
    throw new ConfigError([
      { envVar: '(unknown)', message: 'Invalid configuration' },
    ]);
  }
  return result.data;
}
