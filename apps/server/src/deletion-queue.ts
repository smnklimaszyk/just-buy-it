export type DeletionQueueOptions<T> = {
  capacity: number;
  concurrency: number;
  // Must classify and count its own item. classified() is called as soon as the item has a result.
  work: (item: T, context: { signal: AbortSignal; classified: () => void }) => Promise<void>;
  onDropped: (reason: "dropped" | "dropped_on_shutdown") => void;
  // A throw from work is a bug; the item is not passed on, so its body never reaches a log.
  onError: (error: unknown) => void;
};

export type DeletionQueue<T> = {
  push(item: T): void;
  close(): void;
  drain(ms: number): Promise<{ unfinished: number }>;
  readonly pending: number;
  readonly running: number;
};

// The POST handler only pushes here and returns 204. Workers start on a later turn of the event
// loop, so the 204 is produced before any parsing or key fetch (ADR 0013).
export function createDeletionQueue<T>(options: DeletionQueueOptions<T>): DeletionQueue<T> {
  const waiting: { item: T }[] = [];
  const running = new Set<{ classified: boolean }>();
  const controller = new AbortController();
  const idleWaiters: (() => void)[] = [];
  let closed = false;
  let wakeScheduled = false;

  function push(item: T): void {
    if (closed) {
      options.onDropped("dropped_on_shutdown");
      return;
    }
    if (waiting.length >= options.capacity) {
      options.onDropped("dropped");
      return;
    }
    waiting.push({ item });
    if (!wakeScheduled) {
      wakeScheduled = true;
      setImmediate(() => {
        wakeScheduled = false;
        startWorkers();
      });
    }
  }

  function startWorkers(): void {
    while (running.size < options.concurrency && !controller.signal.aborted) {
      const next = waiting.shift();
      if (!next) break;
      void run(next.item);
    }
  }

  async function run(item: T): Promise<void> {
    const state = { classified: false };
    running.add(state);
    try {
      await options.work(item, {
        signal: controller.signal,
        classified: () => {
          state.classified = true;
        },
      });
    } catch (error) {
      options.onError(error);
    } finally {
      running.delete(state);
      startWorkers();
      if (waiting.length + running.size === 0) idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  // Resolves when the queue is idle or after ms, whichever comes first. Then the shared signal
  // aborts, and every item still queued, or running without a result, is unfinished.
  async function drain(ms: number): Promise<{ unfinished: number }> {
    if (waiting.length + running.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((resolve) => idleWaiters.push(resolve)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, ms));
        }),
      ]);
      clearTimeout(timer);
    }
    controller.abort();
    const unfinished = waiting.length + [...running].filter((state) => !state.classified).length;
    waiting.length = 0;
    return { unfinished };
  }

  return {
    push,
    close: () => {
      closed = true;
    },
    drain,
    get pending() {
      return waiting.length;
    },
    get running() {
      return running.size;
    },
  };
}
