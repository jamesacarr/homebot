import { describe, expect, it } from 'vitest';

import { createUserLock } from '../src/concurrency.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createUserLock', () => {
  it('serialises calls for the same user', async () => {
    const events: string[] = [];
    const lock = createUserLock();

    await Promise.all([
      lock.acquire(1, async () => {
        events.push('1-start');
        await Promise.resolve();
        events.push('1-end');
      }),
      lock.acquire(1, async () => {
        events.push('2-start');
        await Promise.resolve();
        events.push('2-end');
      }),
    ]);

    expect(events).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('runs calls for different users in parallel', async () => {
    const lock = createUserLock();
    const userA = deferred<void>();
    const userB = deferred<void>();
    const events: string[] = [];

    const runA = lock.acquire(1, async () => {
      events.push('a-start');
      await userA.promise;
      events.push('a-end');
    });
    const runB = lock.acquire(2, async () => {
      events.push('b-start');
      await userB.promise;
      events.push('b-end');
    });

    // Yield so both start.
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['a-start', 'b-start']);

    userB.resolve();
    userA.resolve();
    await Promise.all([runA, runB]);
  });

  it('returns the value produced by the callback', async () => {
    const lock = createUserLock();
    const result = await lock.acquire(1, () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('releases the lock even when the callback throws', async () => {
    const lock = createUserLock();

    await expect(
      lock.acquire(1, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    // If the lock were still held, this would hang the test.
    const result = await lock.acquire(1, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });
});
