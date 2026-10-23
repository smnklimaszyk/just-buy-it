export type LogFn = (entry: Record<string, unknown>) => void;
export type Log = { info: LogFn; warn: LogFn; error: LogFn };

// Work that runs after the reply, such as the sign-in mail (spec 7.2): the reply never waits for it.
export type Background = { run(work: () => Promise<void>): void; settled(): Promise<void> };

export function createBackground(log: Log): Background {
  const running = new Set<Promise<void>>();
  return {
    run(work) {
      const task: Promise<void> = work()
        // By name only: an error message can carry an address.
        .catch((error: unknown) => log.error({ event: "background_failed", err_name: error instanceof Error ? error.name : "unknown" }))
        .finally(() => running.delete(task));
      running.add(task);
    },
    // For the tests and the shutdown: resolves once nothing runs any more.
    async settled() {
      while (running.size > 0) await Promise.all(running);
    },
  };
}
