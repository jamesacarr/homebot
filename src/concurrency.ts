export interface UserLock {
  acquire<T>(userId: number, fn: () => Promise<T>): Promise<T>;
}

/**
 * Per-user mutex. Calls with the same userId are serialised; calls with
 * different userIds proceed in parallel. A rejected `fn` still releases the
 * lock so later acquisitions proceed normally.
 *
 * State is in-memory only — a process restart releases all locks, which is
 * acceptable for this use case (user just retries).
 *
 * Memory note: `tails` is never pruned. Every distinct userId that has ever
 * acquired the lock keeps one Promise entry alive for the lifetime of the
 * process. For a home bot with a small set of users this is negligible; a
 * high-cardinality deployment would need periodic cleanup.
 */
export function createUserLock(): UserLock {
  const tails = new Map<number, Promise<unknown>>();

  const acquire = <T>(userId: number, fn: () => Promise<T>): Promise<T> => {
    const prior = tails.get(userId) ?? Promise.resolve();
    // Chain the new work onto the prior tail. Swallow prior errors so they
    // don't cascade into this acquisition.
    const run = prior.then(
      () => fn(),
      () => fn(),
    );
    // Store a tail that can't reject so the next acquirer's chain never
    // explodes before it gets a chance to run.
    tails.set(
      userId,
      run.catch(() => undefined),
    );
    return run;
  };

  return { acquire };
}
