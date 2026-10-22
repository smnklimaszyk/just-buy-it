import type { JobQueue } from "@ebay-sniper/db/queue";
import type { LogFn } from "./handlers/poll.js";
import type { Heartbeat } from "./heartbeat.js";

// Compose sends SIGKILL at stop_grace_period 75s after SIGTERM. Running handlers get 60 s to finish
// their poll_run rows; the hard stop comes before the kill.
export type ShutdownTiming = {
  queueStopMs: number;
  hardStopMs: number;
};

export const SHUTDOWN_TIMING: ShutdownTiming = { queueStopMs: 60_000, hardStopMs: 70_000 };

export type ShutdownDeps = {
  heartbeat: Pick<Heartbeat, "stop">;
  queue: Pick<JobQueue, "stop">;
  endPool: () => Promise<void>;
  log: { info: LogFn; error: LogFn; flush: () => void };
  exit: (code: number) => void;
  timing: ShutdownTiming;
};

// Section 2.6. Returns the handler for SIGTERM and SIGINT; a second signal does nothing.
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { log, timing } = deps;
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    log.info({ event: "shutdown", signal });
    // A handler that outlives the graceful stop would hold the process until Compose kills it; the
    // hard stop ends it first, with the log flushed.
    const hardStop = setTimeout(() => {
      log.error({ event: "shutdown_timeout", signal });
      log.flush();
      deps.exit(1);
    }, timing.hardStopMs);
    hardStop.unref();
    let code = 0;
    try {
      // The heartbeat stops first, so the healthcheck sees the worker going down.
      await deps.heartbeat.stop();
      await deps.queue.stop({ graceful: true, timeoutMs: timing.queueStopMs });
      await deps.endPool();
      log.info({ event: "shutdown_done", signal });
    } catch (error) {
      // The name only: a database error message can carry the connection URL.
      log.error({ event: "shutdown_failed", signal, err_name: error instanceof Error ? error.name : "unknown" });
      code = 1;
    }
    log.flush();
    clearTimeout(hardStop);
    deps.exit(code);
  };
}
