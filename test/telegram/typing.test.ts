import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestLogger } from '../../src/logging.js';
import type { TypingApi } from '../../src/telegram/typing.js';
import {
  sendTypingOnce,
  startTypingHeartbeat,
} from '../../src/telegram/typing.js';

interface TypingCall {
  chatId: number;
  action: string;
}

/**
 * Fake Telegram API that records every `sendChatAction` call. Optionally
 * rejects a configured number of times before succeeding, so we can assert
 * error paths without touching a real socket.
 */
function createFakeTypingApi(opts?: {
  rejectWith?: Error;
  rejectCount?: number;
}): TypingApi & { calls: TypingCall[] } {
  let remainingRejects = opts?.rejectCount ?? 0;
  const calls: TypingCall[] = [];
  return {
    calls,
    sendChatAction(chatId, action): Promise<unknown> {
      calls.push({ action, chatId });
      if (remainingRejects > 0 && opts?.rejectWith) {
        remainingRejects -= 1;
        return Promise.reject(opts.rejectWith);
      }
      return Promise.resolve(true);
    },
  };
}

describe('sendTypingOnce', () => {
  it('posts a typing action for the given chat', async () => {
    const api = createFakeTypingApi();
    const { logger } = createTestLogger();

    await sendTypingOnce(api, 42, logger);

    expect(api.calls).toEqual([{ action: 'typing', chatId: 42 }]);
  });

  it('swallows API errors and logs them at debug with typing_action_failed', async () => {
    const api = createFakeTypingApi({
      rejectCount: 1,
      rejectWith: new Error('forbidden: bot was blocked by the user'),
    });
    const { entries, logger } = createTestLogger();

    // Must not throw — the indicator is cosmetic.
    await expect(sendTypingOnce(api, 42, logger)).resolves.toBeUndefined();

    // pino records level 20 = debug; msg holds the canonical event name.
    const debugRecord = entries.find(
      e => e.msg === 'typing_action_failed' && e.level === 20,
    );
    if (!debugRecord) {
      throw new Error('expected typing_action_failed debug log');
    }
    expect(JSON.stringify(debugRecord.err)).toContain('bot was blocked');
  });
});

describe('startTypingHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a typing action immediately when started', () => {
    const api = createFakeTypingApi();
    const { logger } = createTestLogger();

    const heartbeat = startTypingHeartbeat(api, 7, logger);

    expect(api.calls).toEqual([{ action: 'typing', chatId: 7 }]);
    heartbeat.stop();
  });

  it('re-posts every 4000ms while running', () => {
    const api = createFakeTypingApi();
    const { logger } = createTestLogger();

    const heartbeat = startTypingHeartbeat(api, 7, logger);
    // After the immediate fire, three further intervals should produce three
    // more calls.
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000);

    expect(api.calls).toHaveLength(4);
    expect(api.calls.every(c => c.chatId === 7 && c.action === 'typing')).toBe(
      true,
    );
    heartbeat.stop();
  });

  it('does not re-post after stop() is called', () => {
    const api = createFakeTypingApi();
    const { logger } = createTestLogger();

    const heartbeat = startTypingHeartbeat(api, 7, logger);
    vi.advanceTimersByTime(4000); // second call
    const callsAtStop = api.calls.length;

    heartbeat.stop();
    vi.advanceTimersByTime(60_000);

    expect(api.calls).toHaveLength(callsAtStop);
  });

  it('swallows errors from the API and logs each failure at debug', async () => {
    const api = createFakeTypingApi({
      rejectCount: 2,
      rejectWith: new Error('telegram 429 too many requests'),
    });
    const { entries, logger } = createTestLogger();

    const heartbeat = startTypingHeartbeat(api, 7, logger);
    await vi.advanceTimersByTimeAsync(4000); // second call → also rejects
    heartbeat.stop();

    // The rejected pings are fire-and-forget; flush pending microtasks so
    // the `.catch` handlers (which log) have actually run. Advancing by 0
    // drains microtasks while staying inside the fake timer domain.
    await vi.advanceTimersByTimeAsync(0);

    const debugFailures = entries.filter(
      e => e.msg === 'typing_action_failed' && e.level === 20,
    );
    expect(debugFailures).toHaveLength(2);
    expect(JSON.stringify(debugFailures[0]?.err)).toContain(
      '429 too many requests',
    );
  });
});
