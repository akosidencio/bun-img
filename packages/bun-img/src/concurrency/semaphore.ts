/**
 * Bounded concurrency with a bounded queue.
 *
 * Two rules, and the second one is the whole reason this file has a comment:
 *
 * **The queue is bounded.** An unbounded queue does not shed load, it defers
 * it: latency climbs until every waiter has timed out anyway, and memory grows
 * the whole time. Past `maxPending`, admission fails fast with `QUEUE_FULL` so
 * the caller can return 503 and the client can retry.
 *
 * **A slot is held until the work settles — never released on timeout.** There
 * is no way to abort a running `Bun.Image` pipeline; a timeout can only stop
 * *waiting* for it. Releasing the slot when the caller gives up would admit a
 * replacement while the abandoned transform is still consuming a worker, so the
 * pool oversubscribes, latency collapses, and the queue cascades. Any
 * response-level timeout must therefore wrap this from the *outside*.
 */
import { ImageError } from "../errors.ts";

export interface SemaphoreOptions {
  limit: number;
  maxPending?: number;
}

export interface SemaphoreStats {
  readonly active: number;
  readonly pending: number;
  readonly limit: number;
  readonly maxPending: number;
}

export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly stats: SemaphoreStats;
}

export function createSemaphore(options: SemaphoreOptions): Semaphore {
  const limit = Math.max(1, Math.floor(options.limit));
  const maxPending = Math.max(0, Math.floor(options.maxPending ?? 256));

  let active = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        if (queue.length >= maxPending) {
          throw new ImageError("QUEUE_FULL", 503, "transform queue saturated");
        }
        await new Promise<void>((resolve) => queue.push(resolve));
      }

      active++;
      try {
        // `await` matters: returning the promise unawaited would run `finally`
        // immediately and release the slot while the work is still running.
        return await fn();
      } finally {
        release();
      }
    },

    get stats(): SemaphoreStats {
      return { active, pending: queue.length, limit, maxPending };
    },
  };
}
