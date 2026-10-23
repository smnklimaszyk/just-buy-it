import { randomBytes } from "node:crypto";
import { createPool, runMigrations, type DbPool } from "@ebay-sniper/db";
import type { ModelChoice } from "@ebay-sniper/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsDeps } from "./change.js";
import { runSettingsCommand } from "./settings-command.js";

const AT = new Date("2026-10-22T09:00:00.000Z");
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };

// One migrated database for this file (ADR 0023), dropped at the end.
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const name = `ops_settings_${randomBytes(6).toString("hex")}`;
const databaseUrl = Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
let admin: DbPool;
let pool: DbPool;

beforeAll(async () => {
  if (adminUrl === "") throw new Error("TEST_DATABASE_URL is not set: start Postgres, see README (Local Postgres for tests)");
  admin = createPool({ connectionString: adminUrl, max: 1, applicationName: "ops-test", onError: () => undefined });
  await admin.query(`CREATE DATABASE ${name}`);
  await runMigrations({ connectionString: databaseUrl, log: () => undefined });
  pool = createPool({ connectionString: databaseUrl, max: 2, applicationName: "ops-test", onError: () => undefined });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

function run(args: string[], screeningEvals: readonly ModelChoice[] = []) {
  const out: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const deps: OpsDeps = {
    loadEnv: () => ({ databaseUrl }),
    loadSettingsEnv: () => SETTINGS_ENV,
    loadAuthKey: () => Buffer.alloc(32),
    screeningEvals,
    createPool,
    clock: { now: () => AT },
    out: (line) => out.push(line),
    ask: async () => "",
    log: { info: () => undefined, error: (entry) => errors.push(entry) },
  };
  return { code: runSettingsCommand(args, deps), out, errors };
}

const lines = (out: readonly string[]) => out.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("ops settings", () => {
  it("lists the settings in force, with the code defaults while no row is stored", async () => {
    const result = run(["list"]);

    expect(await result.code).toBe(0);
    expect(lines(result.out)).toEqual([
      {
        settings: {
          claudeModel: "claude-sonnet-5-5",
          claudeEffort: "medium",
          claudeDailyCallLimit: 40,
          claudeDailySpendLimitMicrousd: 2_000_000,
          alertsPerHour: 10,
          alertsPerDay: 60,
          defaultBuyerProfile: "company",
          lowFeedbackBelow: 10,
        },
        warnings: [],
        stored: [],
      },
    ]);
  });

  it("sets one value as system:cli and writes setting.changed", async () => {
    const result = run(["set", "alerts.per_hour", "5"]);

    expect(await result.code).toBe(0);
    expect(lines(result.out)).toEqual([
      expect.objectContaining({ settings: expect.objectContaining({ alertsPerHour: 5 }), plan: expect.objectContaining({ ok: true }) }),
    ]);
    const audit = await pool.query("SELECT actor, action, detail FROM app.audit_event");
    expect(audit.rows).toEqual([
      { actor: "system:cli", action: "setting.changed", detail: { key: "alerts.per_hour", before: null, after: 5 } },
    ]);
  });

  it("refuses a value above the .env ceiling and writes nothing", async () => {
    const result = run(["set", "claude.daily_spend_limit_usd", '"5.00"']);

    expect(await result.code).toBe(1);
    expect(result.errors).toEqual([
      {
        event: "ops",
        step: "refused",
        reason: "invalid",
        errors: [{ key: "claude.daily_spend_limit_usd", error: "The server ceiling is $2.00 a day (CLAUDE_DAILY_SPEND_LIMIT_USD)." }],
      },
    ]);
    expect((await pool.query("SELECT key FROM app.setting")).rows).toEqual([{ key: "alerts.per_hour" }]);
  });

  it("accepts a Claude model only as a pair that passed the screening eval", async () => {
    const notPassed = run(["set", "claude.model", '"claude-haiku-5-5"']);
    expect(await notPassed.code).toBe(1);
    expect(notPassed.errors).toEqual([
      expect.objectContaining({ reason: "invalid", errors: [expect.objectContaining({ key: "claude.model" })] }),
    ]);

    const passed = run(["set", "claude.model", '"claude-haiku-5-5"'], [{ model: "claude-haiku-5-5", effort: "medium" }]);
    expect(await passed.code).toBe(0);
    expect(lines(passed.out)[0]).toMatchObject({ settings: { claudeModel: "claude-haiku-5-5", claudeEffort: "medium" } });
  });

  it.each([[["set", "alerts.per_hour", "five"]], [["set", "alerts.per_hour"]], [["set", "alerts.per_hour", "5", "6"]], [["get"]], [[]]])(
    "exits 2 for %j",
    async (args) => {
      const result = run(args);

      expect(await result.code).toBe(2);
      expect(result.errors).toEqual([expect.objectContaining({ step: "failed", exit_code: 2, err_name: "UsageError" })]);
    },
  );
});
