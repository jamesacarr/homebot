import { describe, expect, it } from 'vitest';

import {
  createLogger,
  createTestLogger,
  silentLogger,
} from '../src/logging.js';

describe('createLogger', () => {
  it('returns a usable pino logger at the configured level', () => {
    const logger = createLogger({ level: 'info', name: 'homebot' });
    expect(typeof logger.info).toBe('function');
    expect(logger.level).toBe('info');
  });
});

describe('silentLogger', () => {
  it('accepts every method without throwing', () => {
    silentLogger.debug('debug');
    silentLogger.info('info');
    silentLogger.warn('warn');
    silentLogger.error('error');
  });
});

describe('createTestLogger', () => {
  it('captures a log entry with message and structured fields', () => {
    const { logger, entries } = createTestLogger();

    logger.info({ telegramUserId: 42 }, 'request_submitted');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toBe('request_submitted');
    expect(entries[0]?.telegramUserId).toBe(42);
  });

  it('records pino level codes (debug=20, info=30, warn=40, error=50)', () => {
    const { logger, entries } = createTestLogger();

    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');

    expect(entries.map(e => e.level)).toEqual([20, 30, 40, 50]);
  });

  it('isolates entries between instances', () => {
    const a = createTestLogger();
    const b = createTestLogger();

    a.logger.info('from-a');
    b.logger.info('from-b');

    expect(a.entries).toHaveLength(1);
    expect(b.entries).toHaveLength(1);
    expect(a.entries[0]?.msg).toBe('from-a');
    expect(b.entries[0]?.msg).toBe('from-b');
  });

  it('child bindings merge into captured entries', () => {
    const { logger, entries } = createTestLogger();
    const child = logger.child({ telegramUserId: 99 });

    child.info({ toolName: 'search_media' }, 'tool_call');

    expect(entries[0]?.telegramUserId).toBe(99);
    expect(entries[0]?.toolName).toBe('search_media');
    expect(entries[0]?.msg).toBe('tool_call');
  });
});
