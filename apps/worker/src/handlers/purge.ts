import { runPurge, type DbPool } from "@ebay-sniper/db";
import type { JobHandler } from "@ebay-sniper/db/queue";
import type { Clock } from "@ebay-sniper/domain";
import type { LogFn } from "./poll.js";

export type PurgeDeps = {
  pool: DbPool;
  clock: Clock;
  log: { info: LogFn; error: LogFn };
};

// Section 7.3, every 15 minutes: retention of the worker's own tables and the ebay_live content.
// runPurge writes the purge_run row; the log carries the counts per step, never content.
export function createPurgeHandler(deps: PurgeDeps): JobHandler<"purge"> {
  return async () => {
    let counts: Record<string, number>;
    try {
      counts = await runPurge(deps.pool, deps.clock);
    } catch (error) {
      // The SQL state only: a database message can quote the statement.
      const sqlState = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
      deps.log.error({ event: "purge", status: "error", sql_state: sqlState });
      throw error;
    }
    deps.log.info({ event: "purge", status: "ok", counts });
  };
}
