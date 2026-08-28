import { describe, expect, test } from "bun:test";
import { createSemaphore } from "../src/concurrency/semaphore.ts";
import { createCoalescer } from "../src/concurrency/coalescer.ts";
import { expectCode } from "./helpers.ts";

describe("semaphore", () => {
  test("runs work and returns its value", async () => {
    const sem = createSemaphore({ limit: 2 });
    expect(await sem.run(async () => 42)).toBe(42);
  });

  test("never exceeds the limit", async () => {
    const sem = createSemaphore({ limit: 3, maxPending: 100 });
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 40 }, () =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active--;
        }),
      ),
    );

    expect(peak).toBe(3);
  });

  test("holds the slot until the work settles, including on failure", async () => {
    // The rule that matters: there is no way to abort a running Bun.Image
    // pipeline, so releasing early would oversubscribe the worker pool.
    const sem = createSemaphore({ limit: 1, maxPending: 10 });
    let active = 0;
    let peak = 0;

    const task = (shouldFail: boolean) =>
      sem
        .run(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active--;
          if (shouldFail) throw new Error("boom");
        })
        .catch(() => {});

    await Promise.all([task(true), task(false), task(true), task(false)]);
    expect(peak).toBe(1);
    expect(sem.stats.active).toBe(0);
  });

  test("releases the slot after a rejection so the queue drains", async () => {
    const sem = createSemaphore({ limit: 1 });
    await sem.run(async () => {
      throw new Error("x");
    }).catch(() => {});
    expect(await sem.run(async () => "ok")).toBe("ok");
  });

  test("sheds load past maxPending instead of queueing forever", async () => {
    // An unbounded queue does not shed load, it defers it: latency climbs until
    // every waiter has timed out anyway, and memory grows the whole time.
    const sem = createSemaphore({ limit: 1, maxPending: 2 });
    const slow = () => sem.run(() => Bun.sleep(50));

    const running = slow(); // takes the slot
    const queued = [slow(), slow()]; // fill the queue

    await expectCode(() => sem.run(async () => "nope"), "QUEUE_FULL");
    await Promise.all([running, ...queued]);
  });

  test("recovers capacity once the queue drains", async () => {
    const sem = createSemaphore({ limit: 1, maxPending: 1 });
    const first = sem.run(() => Bun.sleep(20));
    const second = sem.run(() => Bun.sleep(20));
    await expectCode(() => sem.run(async () => 1), "QUEUE_FULL");
    await Promise.all([first, second]);
    expect(await sem.run(async () => "ok")).toBe("ok");
  });

  test("reports live stats", async () => {
    const sem = createSemaphore({ limit: 2, maxPending: 5 });
    expect(sem.stats).toEqual({ active: 0, pending: 0, limit: 2, maxPending: 5 });

    const work = [sem.run(() => Bun.sleep(30)), sem.run(() => Bun.sleep(30)), sem.run(() => Bun.sleep(30))];
    await Bun.sleep(5);
    expect(sem.stats.active).toBe(2);
    expect(sem.stats.pending).toBe(1);
    await Promise.all(work);
  });

  test("a limit below 1 is clamped rather than deadlocking", async () => {
    const sem = createSemaphore({ limit: 0 });
    expect(await sem.run(async () => "ok")).toBe("ok");
  });
});

describe("coalescer", () => {
  test("100 concurrent identical requests do exactly one unit of work", async () => {
    // The Phase 3 acceptance criterion, and the reason this module exists.
    const coalescer = createCoalescer<string>();
    let runs = 0;

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        coalescer.run("same-key", async () => {
          runs++;
          await Bun.sleep(20);
          return "value";
        }),
      ),
    );

    expect(runs).toBe(1);
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.value === "value")).toBe(true);
    // Exactly one leader; the rest rode along.
    expect(results.filter((r) => !r.coalesced)).toHaveLength(1);
    expect(results.filter((r) => r.coalesced)).toHaveLength(99);
  });

  test("distinct keys do not share work", async () => {
    const coalescer = createCoalescer<number>();
    let runs = 0;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        coalescer.run(`key-${i}`, async () => {
          runs++;
          await Bun.sleep(5);
          return i;
        }),
      ),
    );
    expect(runs).toBe(10);
  });

  test("the window is airtight — a follower arriving one microtask later still joins", async () => {
    // Registering the promise synchronously, before any await inside fn, is
    // what makes this true.
    const coalescer = createCoalescer<string>();
    let runs = 0;
    const work = async () => {
      runs++;
      await Bun.sleep(10);
      return "v";
    };

    const first = coalescer.run("k", work);
    await Promise.resolve();
    const second = coalescer.run("k", work);

    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });

  test("followers share the leader's failure without retrying", async () => {
    // A retry storm behind a failing source is the same thundering herd.
    const coalescer = createCoalescer<string>();
    let runs = 0;

    const attempts = Array.from({ length: 20 }, () =>
      coalescer.run("k", async () => {
        runs++;
        await Bun.sleep(10);
        throw new Error("upstream down");
      }).catch((e) => e.message),
    );

    const results = await Promise.all(attempts);
    expect(runs).toBe(1);
    expect(results.every((m) => m === "upstream down")).toBe(true);
  });

  test("a later request after settling starts fresh work", async () => {
    const coalescer = createCoalescer<number>();
    let runs = 0;
    const work = async () => {
      runs++;
      return runs;
    };

    await coalescer.run("k", work);
    await coalescer.run("k", work);
    expect(runs).toBe(2);
  });

  test("a failure does not poison the key", async () => {
    const coalescer = createCoalescer<string>();
    await coalescer.run("k", async () => {
      throw new Error("once");
    }).catch(() => {});
    const retry = await coalescer.run("k", async () => "recovered");
    expect(retry.value).toBe("recovered");
  });

  test("clears its in-flight map when work settles", async () => {
    const coalescer = createCoalescer<string>();
    await coalescer.run("k", async () => "v");
    expect(coalescer.stats.inflight).toBe(0);
  });

  test("counts coalesced followers", async () => {
    const coalescer = createCoalescer<string>();
    await Promise.all(
      Array.from({ length: 5 }, () => coalescer.run("k", () => Bun.sleep(10).then(() => "v"))),
    );
    expect(coalescer.stats.coalesced).toBe(4);
  });
});

describe("semaphore inside coalescer", () => {
  test("N concurrent identical requests occupy one slot, not N", async () => {
    // The composition the engine relies on: followers wait on the leader's
    // promise rather than each queueing for a transform slot. Nested the other
    // way round, 100 requests for one image would fill the queue and 503.
    const coalescer = createCoalescer<string>();
    const sem = createSemaphore({ limit: 2, maxPending: 4 });
    let transforms = 0;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        coalescer.run("one-image", () =>
          sem.run(async () => {
            transforms++;
            await Bun.sleep(20);
            return "bytes";
          }),
        ),
      ),
    );

    expect(transforms).toBe(1);
    expect(results).toHaveLength(50);
    expect(sem.stats.active).toBe(0);
  });
});
