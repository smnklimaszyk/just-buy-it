import { randomBytes } from "node:crypto";
import { createPool, runMigrations, type DbPool } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsDeps } from "./change.js";
import { runProductsCommand } from "./products-command.js";

const AT = new Date("2026-10-22T09:00:00.000Z");
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };

// One migrated database for this file (ADR 0023), dropped at the end.
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const name = `ops_products_${randomBytes(6).toString("hex")}`;
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

function run(args: string[], settingsEnv = SETTINGS_ENV, at = AT) {
  const out: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const deps: OpsDeps = {
    loadEnv: () => ({ databaseUrl }),
    loadSettingsEnv: () => settingsEnv,
    loadAuthKey: () => Buffer.alloc(32),
    screeningEvals: [],
    createPool,
    clock: { now: () => at },
    out: (line) => out.push(line),
    ask: async () => "",
    log: { info: () => undefined, error: (entry) => errors.push(entry) },
  };
  return { code: runProductsCommand(args, deps), out, errors };
}

const lines = (out: readonly string[]) => out.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("ops products import-legacy", () => {
  it("prints each draft it wrote and the daily call plan, and exits 0", async () => {
    const result = run(["import-legacy"]);

    expect(await result.code).toBe(0);
    const printed = lines(result.out);
    expect(printed.map((line) => line.key)).toEqual(["gpu_3090", "gpu_3090ti", "gpu_4090", "pc_4090", "ram_ddr4", "ram_ddr5", undefined]);
    expect(printed[0]).toMatchObject({ key: "gpu_3090", ruleVersion: 1, status: "draft", maxCents: 52000 });
    expect(printed[6]).toMatchObject({ imported: 6, plan: { total: 204, ceiling: 2500, ok: true } });
  });

  it("exits 1 and logs the refusal when products exist", async () => {
    const result = run(["import-legacy"]);

    expect(await result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.errors).toEqual([{ event: "ops", step: "refused", reason: "products_exist", count: 6 }]);
  });
});

describe("ops products list and show", () => {
  it("lists every product, one JSON line each, by key", async () => {
    const result = run(["list"]);

    expect(await result.code).toBe(0);
    const printed = lines(result.out);
    expect(printed.map((line) => line.key)).toEqual(["gpu_3090", "gpu_3090ti", "gpu_4090", "pc_4090", "ram_ddr4", "ram_ddr5"]);
    expect(printed[0]).toEqual({
      key: "gpu_3090",
      name: "gpu_3090",
      status: "draft",
      version: 1,
      categoryId: "27386",
      priceMode: "fixed",
      maxCents: 52000,
      perGb: false,
      speed: "normal",
    });
  });

  it("shows one product with all its fields, and exits 1 for an unknown key", async () => {
    const shown = run(["show", "ram_ddr5"]);

    expect(await shown.code).toBe(0);
    expect(lines(shown.out)).toEqual([
      expect.objectContaining({
        key: "ram_ddr5",
        version: 1,
        matchVersion: 1,
        watchFrom: null,
        ebayEnabled: true,
        rules: expect.objectContaining({ perGb: true, unitMinTotal: 32, maxCents: 560, searchWords: ["ddr5"] }),
      }),
    ]);
    const unknown = run(["show", "p_unknown123"]);
    expect(await unknown.code).toBe(1);
    expect(unknown.errors).toEqual([{ event: "ops", step: "refused", reason: "not_found", key: "p_unknown123" }]);
  });
});

async function auditSince(at: Date): Promise<{ actor: string; action: string; detail: Record<string, unknown> }[]> {
  const result = await pool.query<{ actor: string; action: string; detail: Record<string, unknown> }>(
    "SELECT actor, action, detail FROM app.audit_event WHERE at >= $1 ORDER BY id",
    [at],
  );
  return result.rows;
}

describe("ops products set", () => {
  const SET_AT = new Date("2026-10-22T10:00:00.000Z");

  it("saves one field through the product rules as system:cli, with a revision and an audit row", async () => {
    const result = run(["set", "gpu_3090", "max_cents", "49000"], SETTINGS_ENV, SET_AT);

    expect(await result.code).toBe(0);
    expect(lines(result.out)).toEqual([
      expect.objectContaining({ key: "gpu_3090", version: 2, rules: expect.objectContaining({ maxCents: 49000 }), plan: expect.objectContaining({ ok: true }) }),
    ]);
    expect(await auditSince(SET_AT)).toEqual([
      {
        actor: "system:cli",
        action: "product.updated",
        detail: { key: "gpu_3090", version: 2, changes: { maxCents: { before: 52000, after: 49000 } } },
      },
    ]);
    const revision = await pool.query("SELECT actor FROM app.product_revision WHERE version = 2");
    expect(revision.rows).toEqual([{ actor: "system:cli" }]);
  });

  it("takes the value of a text field as typed and a list as JSON", async () => {
    expect(await run(["set", "gpu_3090ti", "name", "Graphics card, 24 GB"]).code).toBe(0);
    expect(await run(["set", "gpu_3090ti", "exclude_words", '["defekt","bastler*"]']).code).toBe(0);
    const shown = run(["show", "gpu_3090ti"]);
    await shown.code;
    expect(lines(shown.out)[0]).toMatchObject({
      version: 3,
      rules: { name: "Graphics card, 24 GB", excludeWords: ["defekt", "bastler*"] },
    });
  });

  it("exits 1 with the field errors of the product rules and writes nothing", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM app.audit_event");
    const result = run(["set", "gpu_3090", "search_words", '["rtx-3090"]']);

    expect(await result.code).toBe(1);
    expect(result.errors).toEqual([
      {
        event: "ops",
        step: "refused",
        reason: "invalid",
        issues: [{ path: ["searchWords", 0], message: "Use one word of letters and digits." }],
      },
    ]);
    expect((await pool.query("SELECT count(*)::int AS n FROM app.audit_event")).rows).toEqual(before.rows);
  });

  it("pauses an active product and resumes it, each with a status audit row", async () => {
    const at = new Date("2026-10-22T11:00:00.000Z");
    expect(await run(["set", "gpu_3090", "status", "active"], SETTINGS_ENV, at).code).toBe(0);

    expect(await run(["pause", "gpu_3090"], SETTINGS_ENV, at).code).toBe(0);
    expect(await run(["resume", "gpu_3090"], SETTINGS_ENV, at).code).toBe(0);

    const statuses = (await auditSince(at)).map(({ actor, action, detail }) => [actor, action, detail.before, detail.after]);
    expect(statuses).toEqual([
      ["system:cli", "product.status_changed", "draft", "active"],
      ["system:cli", "product.status_changed", "active", "paused"],
      ["system:cli", "product.status_changed", "paused", "active"],
    ]);
  });

  it("refuses to resume or pause a draft: a draft is activated in the form or with set status", async () => {
    for (const action of ["resume", "pause"]) {
      const result = run([action, "gpu_4090"]);

      expect(await result.code).toBe(1);
      expect(result.errors).toEqual([{ event: "ops", step: "refused", reason: "status", key: "gpu_4090", status: "draft" }]);
    }
    expect((await pool.query("SELECT status FROM app.product WHERE key = 'gpu_4090'")).rows).toEqual([{ status: "draft" }]);
  });

  it("pause-all pauses every active product and leaves the others as they are", async () => {
    const at = new Date("2026-10-22T12:00:00.000Z");
    expect(await run(["set", "gpu_3090ti", "status", "active"], SETTINGS_ENV, at).code).toBe(0);

    const result = run(["pause-all"], SETTINGS_ENV, at);

    expect(await result.code).toBe(0);
    expect(lines(result.out).map((line) => line.key)).toEqual(["gpu_3090", "gpu_3090ti"]);
    const statuses = await pool.query("SELECT key, status FROM app.product ORDER BY key");
    expect(statuses.rows.map((row: { key: string; status: string }) => `${row.key} ${row.status}`)).toEqual([
      "gpu_3090 paused",
      "gpu_3090ti paused",
      "gpu_4090 draft",
      "pc_4090 draft",
      "ram_ddr4 draft",
      "ram_ddr5 draft",
    ]);
    const paused = (await auditSince(at)).filter(({ detail }) => detail.after === "paused");
    expect(paused.map(({ actor, detail }) => [actor, detail.key])).toEqual([
      ["system:cli", "gpu_3090"],
      ["system:cli", "gpu_3090ti"],
    ]);
  });

  it("archives a product of any other status, once", async () => {
    expect(await run(["archive", "ram_ddr5"]).code).toBe(0);
    const again = run(["archive", "ram_ddr5"]);

    expect(await again.code).toBe(1);
    expect(again.errors).toEqual([{ event: "ops", step: "refused", reason: "status", key: "ram_ddr5", status: "archived" }]);
    expect((await pool.query("SELECT status FROM app.product WHERE key = 'ram_ddr5'")).rows).toEqual([{ status: "archived" }]);
  });

  it("refuses a change that takes the daily call plan over 2,500 and writes nothing", async () => {
    const ceilings = { ...SETTINGS_ENV, claudeDailyCallLimit: 1000 };
    await pool.query(`INSERT INTO app.setting (key, value, updated_at) VALUES ('claude.daily_call_limit', '700', $1)`, [AT]);
    try {
      const before = await pool.query("SELECT count(*)::int AS n FROM app.audit_event");
      const result = run(["set", "pc_4090", "status", "active"], ceilings);

      expect(await result.code).toBe(1);
      expect(result.errors).toEqual([
        expect.objectContaining({ step: "refused", reason: "over_budget", plan: expect.objectContaining({ ceiling: 2500, ok: false }) }),
      ]);
      expect((await pool.query("SELECT status FROM app.product WHERE key = 'pc_4090'")).rows).toEqual([{ status: "draft" }]);
      expect((await pool.query("SELECT count(*)::int AS n FROM app.audit_event")).rows).toEqual(before.rows);
    } finally {
      await pool.query("DELETE FROM app.setting");
    }
  });

  it.each([
    [["set", "gpu_3090", "price", "1"]],
    [["set", "gpu_3090", "constructor", "1"]],
    [["set", "gpu_3090", "max_cents", "49.000,00"]],
    [["set", "gpu_3090", "max_cents"]],
    [["set", "gpu_3090", "max_cents", "1", "2"]],
    [["delete", "gpu_3090"]],
    [[]],
  ])("exits 2 for %j and writes nothing", async (args) => {
    const before = await pool.query("SELECT count(*)::int AS n FROM app.audit_event");
    const result = run(args);

    expect(await result.code).toBe(2);
    expect(result.errors).toEqual([expect.objectContaining({ step: "failed", exit_code: 2, err_name: "UsageError" })]);
    expect((await pool.query("SELECT count(*)::int AS n FROM app.audit_event")).rows).toEqual(before.rows);
  });
});
