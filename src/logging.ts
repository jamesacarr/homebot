export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface WritableStreamLike {
  write(chunk: string): boolean;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  stream?: WritableStreamLike;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
};

export function createLogger(options: CreateLoggerOptions): Logger {
  const stream = options.stream ?? process.stdout;
  const minPriority = LEVEL_PRIORITY[options.level];

  const emit = (
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_PRIORITY[level] < minPriority) {
      return;
    }
    // Spread supplied fields first, then reserved keys, so callers can never
    // shadow level/event/timestamp.
    const line = JSON.stringify({
      ...fields,
      event,
      level,
      timestamp: new Date().toISOString(),
    });
    stream.write(`${line}\n`);
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    error: (event, fields) => emit('error', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
  };
}
