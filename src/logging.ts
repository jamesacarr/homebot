import pino, { type Logger } from 'pino';

export type { Logger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CreateLoggerOptions {
  name: string;
  level: LogLevel;
  /** If true, uses pino-pretty for readable output. Recommended only in dev. */
  pretty?: boolean;
}

/**
 * Create a pino root logger. Consumers inside the app should prefer
 * `logger.child({ module: 'foo', telegramUserId: 42 })` to bind context
 * rather than passing fields on every call.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  return pino({
    level: options.level,
    name: options.name,
    ...(options.pretty
      ? {
          transport: {
            options: { colorize: true },
            target: 'pino-pretty',
          },
        }
      : {}),
  });
}

/** A logger that discards all output. Use in tests that don't care about logs. */
export const silentLogger: Logger = pino({ level: 'silent' });

export interface TestLogEntry {
  level: number;
  msg?: string;
  [key: string]: unknown;
}

/**
 * Returns a pino logger whose output is captured into the returned `entries`
 * array. Use in tests that need to assert on log output.
 */
export function createTestLogger(): {
  logger: Logger;
  entries: TestLogEntry[];
} {
  const entries: TestLogEntry[] = [];
  const logger = pino(
    { level: 'trace' },
    {
      write(chunk: string): void {
        entries.push(JSON.parse(chunk) as TestLogEntry);
      },
    },
  );
  return { entries, logger };
}
