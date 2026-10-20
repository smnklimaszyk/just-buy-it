import { describe, expect, it } from "vitest";
import { createDeletionQueue } from "./deletion-queue.js";

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe("createDeletionQueue", () => {
  it("never runs work in the tick of the push, and runs it after setImmediate", async () => {
    const started: number[] = [];
    const queue = createDeletionQueue<number>({
      capacity: 3,
      concurrency: 1,
      work: async (item) => {
        started.push(item);
      },
      onDropped: () => undefined,
      onError: () => undefined,
    });

    queue.push(1);
    expect(started).toEqual([]);
    expect(queue.pending).toBe(1);

    await nextTick();
    expect(started).toEqual([1]);
  });

  it("counts pushes beyond the capacity as dropped and runs the rest in arrival order", async () => {
    const started: number[] = [];
    const finishers: (() => void)[] = [];
    const dropped: string[] = [];
    const queue = createDeletionQueue<number>({
      capacity: 3,
      concurrency: 1,
      work: (item) => {
        started.push(item);
        return new Promise<void>((resolve) => finishers.push(resolve));
      },
      onDropped: (reason) => dropped.push(reason),
      onError: () => undefined,
    });

    for (const item of [1, 2, 3, 4, 5]) queue.push(item);
    expect(dropped).toEqual(["dropped", "dropped"]);

    await nextTick();
    expect([queue.pending, queue.running]).toEqual([2, 1]);
    while (finishers.length > 0) {
      finishers.shift()?.();
      await nextTick();
    }
    expect(started).toEqual([1, 2, 3]);
    expect([queue.pending, queue.running]).toEqual([0, 0]);
  });

  it("counts as unfinished on drain the queued items and the running ones without a result", async () => {
    const signals: AbortSignal[] = [];
    const queue = createDeletionQueue<string>({
      capacity: 10,
      concurrency: 2,
      work: (item, { signal, classified }) => {
        signals.push(signal);
        if (item === "verified, insert still running") classified();
        return new Promise<void>(() => undefined);
      },
      onDropped: () => undefined,
      onError: () => undefined,
    });

    for (const item of ["verified, insert still running", "waiting for a key", "queued 1", "queued 2"]) queue.push(item);
    await nextTick();

    const { unfinished } = await queue.drain(20);

    expect(unfinished).toBe(3);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(queue.pending).toBe(0);
  });

  it("counts pushes after close as dropped_on_shutdown and resolves drain as soon as the queue is idle", async () => {
    const dropped: string[] = [];
    const queue = createDeletionQueue<number>({
      capacity: 10,
      concurrency: 1,
      work: async () => undefined,
      onDropped: (reason) => dropped.push(reason),
      onError: () => undefined,
    });

    queue.push(1);
    queue.close();
    queue.push(2);
    const started = performance.now();
    const { unfinished } = await queue.drain(5_000);

    expect(dropped).toEqual(["dropped_on_shutdown"]);
    expect(unfinished).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("hands a throw from work to onError without the item and goes on with the next item", async () => {
    const errors: unknown[] = [];
    const done: string[] = [];
    const queue = createDeletionQueue<string>({
      capacity: 10,
      concurrency: 1,
      work: async (item) => {
        if (item === "secret-username") throw new Error("bug");
        done.push(item);
      },
      onDropped: () => undefined,
      onError: (...args) => errors.push(args),
    });

    queue.push("secret-username");
    queue.push("next");
    await queue.drain(1_000);

    expect(errors).toEqual([[new Error("bug")]]);
    expect(JSON.stringify(errors)).not.toContain("secret-username");
    expect(done).toEqual(["next"]);
  });

  it("holds at most capacity plus concurrency items when work hangs, and counts the rest dropped", async () => {
    let dropped = 0;
    let most = 0;
    const queue = createDeletionQueue<number>({
      capacity: 1_000,
      concurrency: 4,
      work: () => new Promise<void>(() => undefined),
      onDropped: () => {
        dropped += 1;
      },
      onError: () => undefined,
    });

    for (let i = 0; i < 5_000; i += 1) {
      queue.push(i);
      most = Math.max(most, queue.pending + queue.running);
      if (i % 100 === 0) await nextTick();
    }

    expect(queue.running).toBe(4);
    expect(most).toBeLessThanOrEqual(1_004);
    expect(dropped).toBe(5_000 - queue.pending - queue.running);
  });
});
