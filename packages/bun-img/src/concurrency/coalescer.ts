/**
 * Single-flight request coalescing.
 *
 * When a popular image falls out of cache, every in-flight request for it
 * arrives at once. Without coalescing that is N decodes of the same source for
 * one distinct output — a thundering herd that is worst precisely when the
 * server is busiest.
 *
 * Storing the *promise* rather than the value is what makes the window
 * airtight: a second caller arriving one microtask after the first still finds
 * an entry, because the entry exists from the moment work starts rather than
 * from the moment it finishes.
 */

export interface CoalescerStats {
  readonly inflight: number;
  readonly coalesced: number;
}

export interface Coalescer<T> {
  run(key: string, fn: () => Promise<T>): Promise<{ value: T; coalesced: boolean }>;
  readonly stats: CoalescerStats;
}

export function createCoalescer<T>(): Coalescer<T> {
  const inflight = new Map<string, Promise<T>>();
  let coalesced = 0;

  return {
    async run(key: string, fn: () => Promise<T>): Promise<{ value: T; coalesced: boolean }> {
      const existing = inflight.get(key);
      if (existing) {
        coalesced++;
        // Followers share the leader's outcome, including its failure. They do
        // not retry: a retry storm behind a failing source is the same
        // thundering herd wearing a different hat.
        return { value: await existing, coalesced: true };
      }

      // Registered synchronously, before the first `await` anywhere inside
      // `fn`, so no caller can slip past the check above.
      const pending = fn();
      inflight.set(key, pending);

      try {
        return { value: await pending, coalesced: false };
      } finally {
        inflight.delete(key);
      }
    },

    get stats(): CoalescerStats {
      return { inflight: inflight.size, coalesced };
    },
  };
}
