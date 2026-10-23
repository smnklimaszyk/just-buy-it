import { createInterface } from "node:readline/promises";
import { planProductCalls, type Clock, type DailyCallPlan, type ModelChoice, type SettingsEnv } from "@ebay-sniper/domain";
import { listProducts, loadSettings, type ConfigContext, type createPool, type DbPool, type Queryable } from "@ebay-sniper/db";
import { EnvError, type DatabaseEnv } from "./env.js";

export type OpsLog = {
  info: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};

// loadSettingsEnv and loadAuthKey are read only by the commands that need them, so a missing
// AUTH_KEY does not stop `ops products list`.
export type OpsDeps = {
  loadEnv: () => DatabaseEnv;
  loadSettingsEnv: () => SettingsEnv;
  loadAuthKey: () => Buffer;
  // The (model, effort) pairs that passed the screening eval for the current prompt version.
  screeningEvals: readonly ModelChoice[];
  createPool: typeof createPool;
  clock: Clock;
  out: (line: string) => void;
  // Prints the question and resolves with the line typed in reply.
  ask: (question: string) => Promise<string>;
  log: OpsLog;
};

// Spec 2.7: every change the CLI makes is audited with this actor.
export const ACTOR = "system:cli";

// 0: done, 1: refused or failed, 2: usage.
export class UsageError extends Error {}

// OpsDeps.ask on a terminal. Input that ends before a line is typed (stdin closed, `< /dev/null`)
// is an empty answer, which every question takes as no.
export function terminalQuestion(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): (question: string) => Promise<string> {
  return async (question) => {
    const reader = createInterface({ input, output, terminal: false });
    try {
      return await new Promise<string>((resolve) => {
        reader.once("close", () => resolve(""));
        reader.question(question).then(resolve, () => resolve(""));
      });
    } finally {
      reader.close();
    }
  };
}

// The context of a product or settings save from the CLI: no person behind it.
export function configContext(deps: OpsDeps): ConfigContext {
  return { at: deps.clock.now(), actor: ACTOR, userId: null, env: deps.loadSettingsEnv() };
}

// Spec 5.2: the worst-case Browse calls a day of the stored searches and products, with the
// Claude call limit in force (the setting, at most the .env ceiling). Every save rebuilds the
// searches, so the live rows are the planner's searches.
export async function storedCallPlan(db: Queryable, env: SettingsEnv): Promise<DailyCallPlan> {
  const searches = await db.query<{ day_interval_s: number; night_interval_s: number }>(
    "SELECT day_interval_s, night_interval_s FROM app.search WHERE retired_at IS NULL",
  );
  const products = await listProducts(db);
  const { settings } = await loadSettings(db, env);
  return planProductCalls(
    searches.rows.map((row) => ({ dayIntervalS: row.day_interval_s, nightIntervalS: row.night_interval_s })),
    products.map(({ ebayEnabled, rules }) => ({ status: rules.status, ebayEnabled, priceDropCheck: rules.priceDropCheck })),
    settings,
  );
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

// A store's refusal, logged with its reason and details but without the ok flag. Exit code 1.
// An address shows only its first letter and domain (spec 7.9).
export function refused(deps: OpsDeps, refusal: { ok: false; reason: string } & Record<string, unknown>): number {
  const details = Object.fromEntries(
    Object.entries(refusal)
      .filter(([key]) => key !== "ok")
      .map(([key, value]) => [key, key === "email" && typeof value === "string" ? value.replace(/^(.)[^@]*@/u, "$1…@") : value]),
  );
  deps.log.error({ event: "ops", step: "refused", ...details });
  return 1;
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
  // Not "code": packages/logging redacts a field of that name.
  if (error instanceof Error && "code" in error && typeof error.code === "string") fields.err_code = error.code;
  if (error instanceof Error && "constraint" in error && typeof error.constraint === "string") fields.constraint = error.constraint;
  deps.log.error(fields);
  return exitCode;
}
