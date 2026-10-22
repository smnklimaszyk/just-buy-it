import { randomBytes } from "node:crypto";
import { createPool, listFeeds, runMigrations, type DbPool } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsDeps } from "./change.js";
import { EnvError } from "./env.js";
import { runFeedsCommand } from "./feeds-command.js";

const AT = new Date("2026-10-21T12:00:00.000Z");

// One migrated database for this file (ADR 0023), dropped at the end.
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const name = `ops_feeds_${randomBytes(6).toString("hex")}`;
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

function deps(errors: Record<string, unknown>[], out: string[] = []): OpsDeps {
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
  const code = runFeedsCommand(args, deps(errors, out));
  return { code, out, errors };
}

async function audit(): Promise<{ action: string; detail: unknown }[]> {
  const result = await pool.query<{ action: string; detail: unknown }>("SELECT action, detail FROM app.audit_event ORDER BY id");
  return result.rows;
}

describe("ops feeds", () => {
  it("resumes and pauses a feed, writing one audit_event each", async () => {
    const resumed = run(["resume", "gpu"]);

    expect(await resumed.code).toBe(0);
    expect((await listFeeds(pool)).find((feed) => feed.id === "gpu")?.enabled).toBe(true);
    expect(JSON.parse(resumed.out[0] ?? "{}")).toMatchObject({ id: "gpu", enabled: true });

    expect(await run(["pause", "gpu"]).code).toBe(0);
    expect((await listFeeds(pool)).find((feed) => feed.id === "gpu")?.enabled).toBe(false);
    expect(await audit()).toEqual([
      { action: "feeds.resume", detail: { feed: "gpu", changes: { enabled: { from: false, to: true } } } },
      { action: "feeds.pause", detail: { feed: "gpu", changes: { enabled: { from: true, to: false } } } },
    ]);
  });

  it("sets a field, and refuses a change that puts the daily call plan over 2,500 (section 3.4)", async () => {
    await pool.query("TRUNCATE app.audit_event");

    const category = run(["set", "ram", "category", "170084"]);
    expect(await category.code).toBe(0);
    // gpu at 60 s by day: 1,008 polls, 2,394 calls a day in all.
    expect(await run(["set", "gpu", "day_interval_s", "60"]).code).toBe(0);
    // ram at 60 s as well: 2,874.
    const refused = run(["set", "ram", "day_interval_s", "60"]);

    expect(await refused.code).toBe(1);
    expect(refused.errors).toContainEqual(
      expect.objectContaining({ event: "ops", step: "refused", reason: "call_plan", plan_total: 2874, plan_ceiling: 2500 }),
    );
    const feeds = new Map((await listFeeds(pool)).map((feed) => [feed.id, feed]));
    expect(feeds.get("ram")).toMatchObject({ categoryId: "170084", dayIntervalS: 120 });
    expect(feeds.get("gpu")).toMatchObject({ dayIntervalS: 60 });
    expect((await audit()).map((row) => row.action)).toEqual(["feeds.set", "feeds.set"]);
  });

  it("sets q, the read ceiling, the night interval and the overflow page limit", async () => {
    for (const [field, value] of [
      ["q", "(3090,rtx3090)"],
      ["price_ceiling_cents", "250000"],
      ["night_interval_s", "900"],
      ["overflow_pages_per_day", "10"],
    ]) {
      expect(await run(["set", "pc", field ?? "", value ?? ""]).code, field).toBe(0);
    }

    expect((await listFeeds(pool)).find((feed) => feed.id === "pc")).toMatchObject({
      q: "(3090,rtx3090)",
      priceCeilingCents: 250000,
      nightIntervalS: 900,
      overflowPagesPerDay: 10,
    });
  });

  it("exits 1 with the SQLSTATE and the constraint when the database refuses the value", async () => {
    const result = run(["set", "pc", "day_interval_s", "30"]);

    expect(await result.code).toBe(1);
    expect(result.errors).toContainEqual({
      event: "ops",
      step: "failed",
      exit_code: 1,
      err_name: "DatabaseError",
      code: "23514",
      constraint: "feed_intervals",
    });
    expect((await listFeeds(pool)).find((feed) => feed.id === "pc")?.dayIntervalS).toBe(120);
  });

  it("exits 2 on an invalid environment and 1 on an unreachable database, never logging the URL", async () => {
    const envError = await runFeedsCommand(["pause", "gpu"], {
      ...deps([]),
      loadEnv: () => {
        throw new EnvError("invalid environment: DATABASE_URL");
      },
    });
    const errors: Record<string, unknown>[] = [];
    const unreachable = await runFeedsCommand(["pause", "gpu"], {
      ...deps(errors),
      loadEnv: () => ({ databaseUrl: "postgres://ebay_sniper:sentinel-pw-4711@127.0.0.1:1/ebay_sniper" }),
    });

    expect(envError).toBe(2);
    expect(unreachable).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ event: "ops", step: "failed", exit_code: 1 })]);
    expect(JSON.stringify(errors)).not.toContain("sentinel-pw-4711");
  });

  it.each([
    [["resume", "tv"]],
    [["start", "gpu"]],
    [["pause", "gpu", "now"]],
    [["set", "gpu", "enabled", "true"]],
    [["set", "gpu", "category"]],
    [["set", "gpu", "category", "27386 OR 1=1"]],
    [["set", "gpu", "q", ""]],
    [["set", "gpu", "q", "x".repeat(101)]],
    [["set", "gpu", "day_interval_s", "-60"]],
    [["set", "gpu", "day_interval_s", "60", "extra"]],
  ])("exits 2 for %j and changes nothing", async (args) => {
    await pool.query("TRUNCATE app.audit_event");
    const before = await listFeeds(pool);

    const result = run(args);

    expect(await result.code).toBe(2);
    expect(result.errors).toContainEqual(expect.objectContaining({ event: "ops", step: "failed", exit_code: 2, err_name: "UsageError" }));
    expect(await listFeeds(pool)).toEqual(before);
    expect(await audit()).toEqual([]);
  });
});
