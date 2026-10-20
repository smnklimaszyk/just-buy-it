import type { DeletionCounters } from "./deletion-counters.js";
import type { DeletionQueue } from "./deletion-queue.js";
import type { LogFn } from "./notifications.js";

// Every time counts from the moment the signal arrives (spec S3, section 4). The worst case of each
// step fits before the hard stop, and the hard stop before Compose's SIGKILL at stop_grace_period
// 15s: drain 10 s + final flush 2 s + pool end 1 s = 13 s < 14 s < 15 s.
export type ShutdownTiming = {
  drainMs: number;
  closeConnectionsMs: number;
  flushTimeoutMs: number;
  poolEndMs: number;
  hardStopMs: number;
};

export const SHUTDOWN_TIMING: ShutdownTiming = {
  drainMs: 10_000,
  closeConnectionsMs: 1_000,
  flushTimeoutMs: 2_000,
  poolEndMs: 1_000,
  hardStopMs: 14_000,
};

export type ShutdownDeps = {
  server: { close(): unknown; closeIdleConnections(): void; closeAllConnections(): void };
  queue: Pick<DeletionQueue<unknown>, "close" | "drain">;
  counters: Pick<DeletionCounters, "countResult" | "unsaved" | "flushAll" | "stop">;
  endPool: () => Promise<void>;
  log: { info: LogFn; error: LogFn; flush: () => void };
  // Monotonic milliseconds (ADR 0008).
  now: () => number;
  exit: (code: number) => void;
  timing: ShutdownTiming;
};

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Returns the handler for SIGTERM and SIGINT. A second signal does nothing.
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { server, queue, counters, log, now, exit, timing } = deps;
  let started = false;

  return async function shutdown(signal: string): Promise<void> {
    if (started) return;
    started = true;
    const t0 = now();
    const elapsedMs = () => Math.round(now() - t0);

    const hardStop = setTimeout(() => exit(1), timing.hardStopMs);
    hardStop.unref();

    try {
      // POSTs still arriving on open connections get 204 and count dropped_on_shutdown.
      queue.close();
      // Not awaited: its callback waits for every connection to end, which a slow client controls.
      server.close();
      server.closeIdleConnections();
      // Cuts any request still being received; eBay retries it.
      setTimeout(() => server.closeAllConnections(), timing.closeConnectionsMs).unref();

      const { unfinished } = await queue.drain(t0 + timing.drainMs - now());
      for (let i = 0; i < unfinished; i += 1) counters.countResult("dropped_on_shutdown");
      counters.stop();

      // From here on a SIGKILL loses no count that is not in this line.
      log.info({
        event: "shutdown",
        signal,
        drained: unfinished === 0,
        dropped_on_shutdown: unfinished,
        unsaved_counts: counters.unsaved(),
        elapsed_ms: elapsedMs(),
      });
      log.flush();

      const countsSaved = await within(counters.flushAll(), timing.flushTimeoutMs, false);
      await within(
        deps.endPool().catch(() => undefined),
        timing.poolEndMs,
        undefined,
      );

      log.info({ event: "shutdown_done", counts_saved: countsSaved, elapsed_ms: elapsedMs() });
      clearTimeout(hardStop);
      exit(0);
    } catch (error) {
      // A bug in a step: the hard stop ends the process.
      log.error({ event: "shutdown_failed", err_name: error instanceof Error ? error.name : "unknown" });
    }
  };
}
