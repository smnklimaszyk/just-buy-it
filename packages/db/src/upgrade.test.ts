import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Spec V1: the v2 migrations 0007 to 0011 run on a database that Release 0 left at 0006 with rows,
// change none of those rows and add no product.

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
const silent = (): void => undefined;

type Journal = { entries: { idx: number; tag: string }[] };

let database: TestDatabase;
let releaseZeroFolder: string;

// The migrations folder as Release 0 shipped it: entries 0000 to 0006 only.
function folderAt0006(): string {
  const path = mkdtempSync(join(tmpdir(), "ebay-sniper-release-0-"));
  cpSync(migrationsFolder, path, { recursive: true });
  const journalPath = join(path, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  for (const entry of journal.entries.filter((e) => e.idx > 6)) rmSync(join(path, `${entry.tag}.sql`));
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 6) }, null, 2));
  return path;
}

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "empty" });
  releaseZeroFolder = folderAt0006();
});

afterAll(async () => {
  await database.drop();
  rmSync(releaseZeroFolder, { recursive: true, force: true });
});

const KEY = "e".repeat(64);
const AT = new Date("2026-10-21T10:00:00.000Z");

async function snapshot(): Promise<Record<string, unknown[]>> {
  const rows = async (sql: string) => (await database.pool.query(sql)).rows;
  return {
    feed: await rows("SELECT * FROM app.feed ORDER BY id"),
    segmentRule: await rows("SELECT * FROM app.segment_rule ORDER BY segment"),
    candidate: await rows("SELECT id, item_key, decision, segment, feed_id, price_cents FROM app.candidate"),
    seenItem: await rows("SELECT * FROM app.seen_item"),
    auditEvent: await rows("SELECT * FROM app.audit_event"),
    alert: await rows("SELECT * FROM app.alert"),
  };
}

describe("migrating a Release 0 database to v2", () => {
  it("applies 0007 to 0011 on a database at 0006 with rows, keeps every row and adds no product", async () => {
    const first = await runMigrations({ connectionString: database.url, log: silent, migrationsFolder: releaseZeroFolder });
    expect(first.drizzleApplied).toBe(7);
    const candidate = await database.pool.query<{ id: string }>(
      `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, price_cents, shipping_known, rule_version, decision)
       VALUES ($1, '00000000-0000-7000-8000-0000000000b1', 'gpu', 'gpu_3090', 'poll', 50000, true, 1, 'alerted') RETURNING id`,
      [KEY],
    );
    await database.pool.query(
      "INSERT INTO app.seen_item (item_key, key_version, feed_id, segment, outcome, first_seen_at, last_seen_at) VALUES ($1, 1, 'gpu', 'gpu_3090', 'candidate', $2, $2)",
      [KEY, AT],
    );
    await database.pool.query("INSERT INTO app.audit_event (at, actor, action, detail) VALUES ($1, 'system:cli', 'rules.set', '{}')", [AT]);
    await database.pool.query(
      `INSERT INTO app.alert (item_key, candidate_id, segment, final_verdict, blocked_by_code, screened, rule_version, buyer_profile)
       VALUES ($1, $2, 'gpu_3090', 'pass', false, true, 1, 'company')`,
      [KEY, candidate.rows[0]?.id],
    );
    await database.pool.query("UPDATE app.segment_rule SET max_landed_cents = 51000, rule_version = 2 WHERE segment = 'gpu_3090'");
    const before = await snapshot();

    const second = await runMigrations({ connectionString: database.url, log: silent });

    expect(second).toEqual({ drizzleApplied: 5, newerThanRelease: 0 });
    expect(await snapshot()).toEqual(before);
    const added = await database.pool.query<{ products: number; product_version: number | null; limit_cents: number | null }>(
      `SELECT (SELECT count(*)::int FROM app.product) AS products, product_version, limit_cents FROM app.candidate`,
    );
    expect(added.rows).toEqual([{ products: 0, product_version: null, limit_cents: null }]);
    expect(before.segmentRule).toHaveLength(6);
  });
});
