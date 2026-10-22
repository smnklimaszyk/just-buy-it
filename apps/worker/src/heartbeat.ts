import { writeFile } from "node:fs/promises";
import { recordHeartbeat, type Queryable } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import type { Clock } from "@ebay-sniper/domain";
import type { LogFn } from "./handlers/poll.js";

export type HeartbeatDeps = {
  pool: Queryable;
  queue: Pick<JobQueue, "isStarted">;
  clock: Clock;
  // The Compose healthcheck fails when this file is older than 30 s.
  file: string;
  log: { warn: LogFn };
  // Default 10 s, the healthcheck's interval.
  intervalMs?: number;
};

export type Heartbeat = {
  beat(): Promise<void>;
  // Beats at once, then every interval.
  start(): void;
  // No beat starts after this; resolves when a running one has finished.
  stop(): Promise<void>;
};

const HEARTBEAT_INTERVAL_MS = 10_000;

// Section 2.6: the worker counts as alive only while the database answers and pg-boss runs.
export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;

  // A skipped beat leaves the file to age, so Compose marks the worker unhealthy after 30 s.
  async function beat(): Promise<void> {
    // The alive file is touched only while pg-boss runs.
    if (!deps.queue.isStarted()) {
      deps.log.warn({ event: "heartbeat_skipped", reason: "queue_stopped" });
      return;
    }
    try {
      await deps.pool.query("SELECT 1");
      await writeFile(deps.file, "");
      await recordHeartbeat(deps.pool, deps.clock.now());
    } catch (error) {
      // The code only: a connection error message can carry the database URL.
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
      deps.log.warn({ event: "heartbeat_skipped", reason: "database", err_code: code });
    }
  }

  // A beat still running when the next is due (a slow database) is not doubled.
  function tick(): void {
    if (running !== null) return;
    running = beat().finally(() => {
      running = null;
    });
  }

  return {
    beat,
    start() {
      tick();
      timer = setInterval(tick, deps.intervalMs ?? HEARTBEAT_INTERVAL_MS);
      // pg-boss keeps the process running; the timer alone must not.
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
