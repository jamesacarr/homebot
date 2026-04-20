import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logging.js';

class CapturingStream {
  public readonly writes: string[] = [];

  write(chunk: string | Buffer): boolean {
    this.writes.push(
      typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
    );
    return true;
  }
}

function parseLast(stream: CapturingStream): Record<string, unknown> {
  const last = stream.writes.at(-1);
  if (last === undefined) {
    throw new Error('no writes captured');
  }
  return JSON.parse(last) as Record<string, unknown>;
}

describe('createLogger', () => {
  it('writes one JSON line per call with level, event, and timestamp', () => {
    const stream = new CapturingStream();
    const log = createLogger({ level: 'info', stream });

    log.info('startup');

    expect(stream.writes).toHaveLength(1);
    const line = stream.writes[0];
    expect(line?.endsWith('\n')).toBe(true);

    const parsed = parseLast(stream);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('startup');
    expect(typeof parsed.timestamp).toBe('string');
    expect(() =>
      new Date(parsed.timestamp as string).toISOString(),
    ).not.toThrow();
  });

  it('merges supplied fields into the logged entry', () => {
    const stream = new CapturingStream();
    const log = createLogger({ level: 'info', stream });

    log.info('request_submitted', { title: 'Fight Club', tmdbId: 550 });

    const parsed = parseLast(stream);
    expect(parsed.tmdbId).toBe(550);
    expect(parsed.title).toBe('Fight Club');
    expect(parsed.event).toBe('request_submitted');
  });

  it('suppresses calls below the configured level', () => {
    const stream = new CapturingStream();
    const log = createLogger({ level: 'warn', stream });

    log.debug('ignored');
    log.info('ignored');
    log.warn('kept');
    log.error('kept');

    expect(stream.writes).toHaveLength(2);
    expect(parseLast(stream).level).toBe('error');
  });

  it('does not let supplied fields overwrite level, event, or timestamp', () => {
    const stream = new CapturingStream();
    const log = createLogger({ level: 'info', stream });

    log.info('real_event', {
      event: 'hacked',
      level: 'debug',
      timestamp: 'pwned',
    });

    const parsed = parseLast(stream);
    expect(parsed.event).toBe('real_event');
    expect(parsed.level).toBe('info');
    expect(parsed.timestamp).not.toBe('pwned');
  });
});
