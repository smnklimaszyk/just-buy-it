import { randomBytes } from "node:crypto";
import { createPool, listSegmentRules, runMigrations, type DbPool } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsDeps } from "./change.js";
import { runRulesCommand } from "./rules-command.js";

const AT = new Date("2026-10-21T12:00:00.000Z");

// One migrated database for this file (ADR 0023), dropped at the end.
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const name = `ops_rules_${randomBytes(6).toString("hex")}`;
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

function deps(errors: Record<string, unknown>[], out: string[]): OpsDeps {
  return {
    loadEnv: () => ({ databaseUrl }),
    createPool,
    clock: { now: () => AT },
    out: (line) => out.push(line),
    log: { info: () => undefined, error: (entry) => errors.push(entry) },
  };
}

function run(args: string[]) {
  const out: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const code = runRulesCommand(args, deps(errors, out));
  return { code, out, errors };
}

async function audit(): Promise<{ action: string; detail: unknown }[]> {
  const result = await pool.query<{ action: string; detail: unknown }>("SELECT action, detail FROM app.audit_event ORDER BY id");
  return result.rows;
}

describe("ops rules", () => {
  it("sets a field, bumps rule_version and writes audit_event", async () => {
    const result = run(["set", "gpu_3090", "max_landed_cents", "49000"]);

    expect(await result.code).toBe(0);
    expect(JSON.parse(result.out[0] ?? "{}")).toMatchObject({ segment: "gpu_3090", maxLandedCents: 49000, ruleVersion: 2 });
    expect((await listSegmentRules(pool)).find((rule) => rule.segment === "gpu_3090")).toMatchObject({
      maxLandedCents: 49000,
      ruleVersion: 2,
    });
    expect(await audit()).toEqual([
      {
        action: "rules.set",
        detail: {
          segment: "gpu_3090",
          rule_version: { from: 1, to: 2 },
          changes: { max_landed_cents: { from: 52000, to: 49000 } },
        },
      },
    ]);
  });

  it("sets every owner-tunable field of a rule (section 3.5 procedure)", async () => {
    for (const [segment, field, value] of [
      ["gpu_4090", "floor_cents", "60000"],
      ["ram_ddr4", "max_cents_per_gb", "300"],
      ["ram_ddr4", "min_cents_per_gb", "150"],
      ["ram_ddr4", "min_total_gb", "64"],
      ["ram_ddr4", "sweep_q", "(ddr4,ddr-4)"],
      ["ram_ddr4", "candidate_cap_per_day", "100"],
      ["ram_ddr4", "enabled", "false"],
    ]) {
      expect(await run(["set", segment ?? "", field ?? "", value ?? ""]).code, field).toBe(0);
    }

    const rules = new Map((await listSegmentRules(pool)).map((rule) => [rule.segment, rule]));
    expect(rules.get("gpu_4090")).toMatchObject({ floorCents: 60000 });
    expect(rules.get("ram_ddr4")).toMatchObject({
      maxCentsPerGb: 300,
      minCentsPerGb: 150,
      minTotalGb: 64,
      sweepQ: "(ddr4,ddr-4)",
      candidateCapPerDay: 100,
      enabled: false,
      ruleVersion: 7,
    });
  });

  it("refuses a change while the daily call plan is over 2,500, and writes nothing", async () => {
    await pool.query("TRUNCATE app.audit_event");
    await pool.query("UPDATE app.feed SET day_interval_s = 60, night_interval_s = 60");
    try {
      const result = run(["set", "gpu_3090", "max_landed_cents", "48000"]);

      expect(await result.code).toBe(1);
      expect(result.errors).toContainEqual(expect.objectContaining({ step: "refused", reason: "call_plan", plan_ceiling: 2500 }));
      expect((await listSegmentRules(pool)).find((rule) => rule.segment === "gpu_3090")).toMatchObject({ maxLandedCents: 49000 });
      expect(await audit()).toEqual([]);
    } finally {
      await pool.query("UPDATE app.feed SET day_interval_s = 120, night_interval_s = 600");
    }
  });

  it("lists the six rules, one JSON line each, and the daily call plan", async () => {
    const result = run(["list"]);

    expect(await result.code).toBe(0);
    const lines = result.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.slice(0, 6).map((line) => line.segment)).toEqual([
      "gpu_3090",
      "gpu_3090ti",
      "gpu_4090",
      "ram_ddr4",
      "ram_ddr5",
      "pc_4090",
    ]);
    expect(lines[0]).toMatchObject({ segment: "gpu_3090", kind: "per_item", maxLandedCents: 49000 });
    expect(lines[6]).toEqual({ plan: { polls: 1584, overflowPages: 60, sweeps: 144, getItem: 126, total: 1914, ceiling: 2500, withinCeiling: true } });
  });

  it.each([
    [["set", "gpu_5090", "max_landed_cents", "1"]],
    [["set", "gpu_3090", "price", "1"]],
    [["set", "gpu_3090", "max_landed_cents", "49.5"]],
    [["set", "gpu_3090", "enabled", "yes"]],
    [["set", "gpu_3090", "sweep_q", ""]],
    [["set", "gpu_3090", "max_landed_cents"]],
    [["set", "gpu_3090", "max_landed_cents", "1", "2"]],
    [["delete", "gpu_3090"]],
    [[]],
  ])("exits 2 for %j", async (args) => {
    const result = run(args);

    expect(await result.code).toBe(2);
    expect(result.errors).toContainEqual(expect.objectContaining({ step: "failed", exit_code: 2, err_name: "UsageError" }));
  });
});
