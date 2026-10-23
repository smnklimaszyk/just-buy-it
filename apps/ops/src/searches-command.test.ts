import { randomBytes } from "node:crypto";
import { createPool, runMigrations, saveProductWithPlan, type DbPool } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsDeps } from "./change.js";
import { runPlanCommand, runSearchesCommand } from "./searches-command.js";

const AT = new Date("2026-10-22T09:00:00.000Z");
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };

// One migrated database for this file (ADR 0023), dropped at the end.
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const name = `ops_searches_${randomBytes(6).toString("hex")}`;
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

function deps(out: string[], errors: Record<string, unknown>[]): OpsDeps {
  return {
    loadEnv: () => ({ databaseUrl }),
    loadSettingsEnv: () => SETTINGS_ENV,
    loadAuthKey: () => Buffer.alloc(32),
    screeningEvals: [],
    createPool,
    clock: { now: () => AT },
    out: (line) => out.push(line),
    ask: async () => "",
    log: { info: () => undefined, error: (entry) => errors.push(entry) },
  };
}

describe("ops plan", () => {
  it("prints the daily call plan of the stored rows with the Claude call limit in force", async () => {
    // Stored above the .env ceiling of 40: the plan counts getItem calls for 40.
    await pool.query("INSERT INTO app.setting (key, value, updated_at) VALUES ('claude.daily_call_limit', '100', $1)", [AT]);
    const out: string[] = [];

    expect(await runPlanCommand([], deps(out, []))).toBe(0);
    expect(out.map((line) => JSON.parse(line) as unknown)).toEqual([
      { polls: 0, overflow: 0, sweeps: 0, getItem: 126, market: 60, total: 186, ceiling: 2500, ok: true },
    ]);
  });
});

describe("ops searches list", () => {
  it("lists the derived searches with the keys of their products", async () => {
    const ctx = { at: AT, actor: "system:cli", userId: null, env: SETTINGS_ENV };
    const fields = (name: string, word: string) => ({
      name,
      description: "A test product",
      status: "active",
      categoryId: "9355",
      conditionIds: ["1000"],
      searchWords: [word],
      mustWords: [[word]],
      priceMode: "fixed",
      maxCents: 50000,
    });
    for (const [key, word] of [["lens_a", "objektiv"], ["lens_b", "linse"]] as const) {
      const saved = await saveProductWithPlan(pool, { kind: "create", key, fields: fields(key, word) }, ctx);
      expect(saved.ok).toBe(true);
    }
    const out: string[] = [];

    expect(await runSearchesCommand(["list"], deps(out, []))).toBe(0);
    expect(out.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        id: "s1",
        q: "(linse,objektiv)",
        categoryId: "9355",
        conditionIds: ["1000"],
        floorEur: 200,
        ceilingEur: 1000,
        dayIntervalS: 300,
        nightIntervalS: 600,
        enabled: true,
        retiredAt: null,
        products: ["lens_a", "lens_b"],
      },
    ]);
  });

  it("exits 2 for other arguments of searches or plan", async () => {
    const errors: Record<string, unknown>[] = [];

    expect(await runSearchesCommand(["show", "s1"], deps([], errors))).toBe(2);
    expect(await runSearchesCommand([], deps([], errors))).toBe(2);
    expect(await runPlanCommand(["now"], deps([], errors))).toBe(2);
    expect(errors).toHaveLength(3);
    expect(errors.every((error) => error.err_name === "UsageError")).toBe(true);
  });
});
