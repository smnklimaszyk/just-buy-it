import { planDailyCalls, type CallPlan, type Clock } from "@ebay-sniper/domain";
import { listFeeds, listSegmentRules, type createPool, type DbPool, type Queryable } from "@ebay-sniper/db";
import { EnvError, type DatabaseEnv } from "./env.js";

export type OpsLog = {
  info: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};

export type OpsDeps = {
  loadEnv: () => DatabaseEnv;
  createPool: typeof createPool;
  clock: Clock;
  out: (line: string) => void;
  log: OpsLog;
};

export const ACTOR = "system:cli";

// The worker's default CLAUDE_DAILY_CALL_LIMIT. ops does not read the worker's environment; the
// worker checks the plan again with its own limit before it schedules polls (section 3.4).
export const PLAN_CLAUDE_CALL_LIMIT = 40;

export class UsageError extends Error {}

// Runs one change and its audit row in a transaction as the owner. With checkPlan, the change is
// rolled back when the daily call plan of the changed config is over the ceiling.
// 0: done, 1: refused or failed, 2: usage.
export async function runChange<T>(
  deps: OpsDeps,
  options: { checkPlan: boolean },
  change: (db: Queryable, audit: { at: Date; actor: string }) => Promise<T | null>,
): Promise<number> {
  return withPool(deps, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await change(client, { at: deps.clock.now(), actor: ACTOR });
      if (result === null) {
        await client.query("ROLLBACK");
        deps.log.error({ event: "ops", step: "refused", reason: "not_found" });
        return 1;
      }
      if (options.checkPlan) {
        const plan = await callPlan(client);
        if (!plan.withinCeiling) {
          await client.query("ROLLBACK");
          deps.log.error({ event: "ops", step: "refused", reason: "call_plan", plan_total: plan.total, plan_ceiling: plan.ceiling });
          return 1;
        }
      }
      await client.query("COMMIT");
      deps.out(JSON.stringify(result));
      return 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

// The worst-case Browse calls a day of the stored feeds and rules (section 3.4).
export async function callPlan(db: Queryable): Promise<CallPlan> {
  return planDailyCalls(await listFeeds(db), await listSegmentRules(db), PLAN_CLAUDE_CALL_LIMIT);
}

// One connection as the owner for the command; every failure goes through failed().
export async function withPool(deps: OpsDeps, fn: (pool: DbPool) => Promise<number>): Promise<number> {
  try {
    const pool = deps.createPool({
      connectionString: deps.loadEnv().databaseUrl,
      max: 1,
      applicationName: "ebay-sniper-ops",
      onError: () => undefined,
    });
    try {
      return await fn(pool);
    } finally {
      await pool.end();
    }
  } catch (error) {
    return failed(deps, error);
  }
}

// Logs the error class, the SQLSTATE and the constraint, never the message: a driver message can
// quote a value or the connection string.
export function failed(deps: OpsDeps, error: unknown): number {
  const exitCode = error instanceof UsageError || error instanceof EnvError ? 2 : 1;
  const fields: Record<string, unknown> = {
    event: "ops",
    step: "failed",
    exit_code: exitCode,
    err_name: error instanceof Error ? error.constructor.name : typeof error,
  };
  if (error instanceof UsageError) fields.err_message = error.message;
  if (error instanceof Error && "code" in error && typeof error.code === "string") fields.code = error.code;
  if (error instanceof Error && "constraint" in error && typeof error.constraint === "string") fields.constraint = error.constraint;
  deps.log.error(fields);
  return exitCode;
}

// The database's check constraints decide the allowed range.
export function wholeNumber(field: string, value: string): number {
  if (!/^[0-9]{1,9}$/.test(value)) throw new UsageError(`${field} must be a whole number`);
  return Number(value);
}
