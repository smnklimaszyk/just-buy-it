import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, listProducts, runMigrations, type DbPool } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importLegacyProducts } from "./legacy-import.js";

const AT = new Date("2026-10-22T09:00:00.000Z");
const CTX = {
  at: AT,
  actor: "system:import",
  userId: null,
  env: { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null },
};
const DESCRIPTION = "Imported from the MVP; describe the product before activating";

// One database for this file (ADR 0023), left at 0006 by Release 0, edited, then migrated to HEAD.
const adminUrl = process.env.TEST_DATABASE_URL ?? "";
const name = `ops_import_${randomBytes(6).toString("hex")}`;
const databaseUrl = Object.assign(new URL(adminUrl), { pathname: `/${name}` }).toString();
const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
let releaseZeroFolder: string;
let admin: DbPool;
let pool: DbPool;

type Journal = { entries: { idx: number; tag: string }[] };

// The migrations folder as Release 0 shipped it: entries 0000 to 0006 only.
function folderAt0006(): string {
  const path = mkdtempSync(join(tmpdir(), "ops-release-0-"));
  cpSync(migrationsFolder, path, { recursive: true });
  const journalPath = join(path, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  for (const entry of journal.entries.filter((e) => e.idx > 6)) rmSync(join(path, `${entry.tag}.sql`));
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 6) }, null, 2));
  return path;
}

beforeAll(async () => {
  if (adminUrl === "") throw new Error("TEST_DATABASE_URL is not set: start Postgres, see README (Local Postgres for tests)");
  admin = createPool({ connectionString: adminUrl, max: 1, applicationName: "ops-test", onError: () => undefined });
  await admin.query(`CREATE DATABASE ${name}`);
  releaseZeroFolder = folderAt0006();
  await runMigrations({ connectionString: databaseUrl, log: () => undefined, migrationsFolder: releaseZeroFolder });
  pool = createPool({ connectionString: databaseUrl, max: 2, applicationName: "ops-test", onError: () => undefined });
  // Edits Release 0 made with `ops rules set` and `ops feeds set`, which the import must keep.
  await pool.query(
    "UPDATE app.segment_rule SET max_landed_cents = 51000, candidate_cap_per_day = 5, rule_version = 3 WHERE segment = 'gpu_3090'",
  );
  await pool.query(
    "UPDATE app.segment_rule SET min_total_gb = 64, max_cents_per_gb = 300, sweep_q = '(ddr4,ddr4ram)', rule_version = 4 WHERE segment = 'ram_ddr4'",
  );
  await pool.query("UPDATE app.feed SET price_ceiling_cents = 250000, condition_ids = '{1500,3000}' WHERE id = 'gpu'");
  await runMigrations({ connectionString: databaseUrl, log: () => undefined });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  rmSync(releaseZeroFolder, { recursive: true, force: true });
});

describe("importLegacyProducts", () => {
  it("refuses before writing anything when one rule gives no valid product", async () => {
    await pool.query("UPDATE app.segment_rule SET sweep_q = '(4090,rtx-4090)' WHERE segment = 'gpu_4090'");
    try {
      expect(await importLegacyProducts(pool, CTX)).toEqual({
        ok: false,
        reason: "invalid",
        key: "gpu_4090",
        issues: [{ path: ["searchWords", 1], message: "Use one word of letters and digits." }],
      });
      expect(await listProducts(pool)).toEqual([]);
      expect((await pool.query("SELECT * FROM app.audit_event")).rows).toEqual([]);
    } finally {
      await pool.query("UPDATE app.segment_rule SET sweep_q = '(4090,rtx4090)' WHERE segment = 'gpu_4090'");
    }
  });

  it("writes the six segment rules as drafts with the values the database holds now", async () => {
    const result = await importLegacyProducts(pool, CTX);

    expect(result).toMatchObject({ ok: true, plan: { total: 204, ok: true } });
    expect(result.ok && result.products.map(({ product, ruleVersion }) => [product.key, ruleVersion])).toEqual([
      ["gpu_3090", 3],
      ["gpu_3090ti", 1],
      ["gpu_4090", 1],
      ["pc_4090", 1],
      ["ram_ddr4", 4],
      ["ram_ddr5", 1],
    ]);
    const products = new Map((await listProducts(pool)).map((product) => [product.key, product]));
    expect([...products.keys()]).toEqual(["gpu_3090", "gpu_3090ti", "gpu_4090", "pc_4090", "ram_ddr4", "ram_ddr5"]);
    expect(products.get("gpu_3090")?.rules).toEqual({
      name: "gpu_3090",
      description: DESCRIPTION,
      status: "draft",
      categoryId: "27386",
      categoryName: null,
      conditionIds: ["1500", "3000"],
      searchWords: ["3090", "rtx3090"],
      mustWords: [["3090", "rtx3090"]],
      excludeWords: [],
      warnWords: [],
      useDefaultJunk: true,
      junkExceptions: [],
      accessoryCheck: true,
      perGb: false,
      unitMinTotal: null,
      unitMaxTotal: null,
      priceMode: "fixed",
      maxCents: 51000,
      belowMarketPct: null,
      floorCents: 26000,
      readCeilingCents: 250000,
      speed: "normal",
      priceDropCheck: true,
      candidateCapPerDay: 5,
      buyerProfile: "company",
      claudeRequired: false,
      alertRecipientIds: [],
    });
    expect(products.get("ram_ddr4")?.rules).toMatchObject({
      categoryId: "170083",
      searchWords: ["ddr4", "ddr4ram"],
      mustWords: [["ddr4", "ddr4ram"]],
      perGb: true,
      maxCents: 300,
      floorCents: 160,
      unitMinTotal: 64,
      unitMaxTotal: 64,
      readCeilingCents: 120000,
      candidateCapPerDay: 20,
    });
    expect(products.get("pc_4090")?.rules).toMatchObject({ categoryId: "179", maxCents: 192000, searchWords: ["4090", "rtx4090"] });
    const revisions = await pool.query<{ actor: string }>("SELECT DISTINCT actor FROM app.product_revision");
    expect(revisions.rows).toEqual([{ actor: "system:import" }]);
    const audit = await pool.query<{ actor: string; action: string; n: number }>(
      "SELECT actor, action, count(*)::int AS n FROM app.audit_event GROUP BY actor, action ORDER BY action",
    );
    expect(audit.rows).toEqual([
      { actor: "system:import", action: "import.legacy_products", n: 1 },
      { actor: "system:import", action: "product.created", n: 6 },
    ]);
  });

  it("refuses when any product exists and writes nothing", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM app.audit_event");

    expect(await importLegacyProducts(pool, CTX)).toEqual({ ok: false, reason: "products_exist", count: 6 });
    expect((await pool.query("SELECT count(*)::int AS n FROM app.audit_event")).rows).toEqual(before.rows);
    expect(await listProducts(pool)).toHaveLength(6);
  });

  it("finishes an import that failed after its first drafts when it runs again", async () => {
    await pool.query("TRUNCATE app.product, app.search, app.audit_event CASCADE");
    await pool.query(
      `CREATE FUNCTION public.fail_third() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'connection lost' USING ERRCODE = '08006'; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER fail_third BEFORE INSERT ON app.product FOR EACH ROW WHEN (NEW.key = 'gpu_4090') EXECUTE FUNCTION public.fail_third()",
    );
    try {
      await expect(importLegacyProducts(pool, CTX)).rejects.toThrow("connection lost");
    } finally {
      await pool.query("DROP TRIGGER fail_third ON app.product");
      await pool.query("DROP FUNCTION public.fail_third()");
    }
    expect((await listProducts(pool)).map((product) => product.key), "drafts saved before the failure").toEqual(["gpu_3090", "gpu_3090ti"]);

    const again = await importLegacyProducts(pool, CTX);

    expect(again).toMatchObject({ ok: true, plan: { total: 204, ok: true } });
    expect(await listProducts(pool)).toHaveLength(6);
    const audit = await pool.query<{ action: string; n: number }>(
      "SELECT action, count(*)::int AS n FROM app.audit_event GROUP BY action ORDER BY action",
    );
    expect(audit.rows).toEqual([
      { action: "import.legacy_products", n: 1 },
      { action: "product.created", n: 6 },
    ]);
    expect(await importLegacyProducts(pool, CTX), "a third run").toEqual({ ok: false, reason: "products_exist", count: 6 });
  });
});
