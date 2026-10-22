import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DASHBOARD_QUERIES } from "./dashboard.js";
import { RETENTION } from "./retention.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Sections 2.5 and 8.2: the worker and dashboard roles get exactly these rights (migration 0005).

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

// "schema.table PRIVILEGE" for every table-level grant to the role, in every schema.
async function tableGrants(role: string): Promise<string[]> {
  const result = await database.pool.query<{ grant: string }>(
    `SELECT n.nspname || '.' || c.relname || ' ' || a.privilege_type AS grant
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
      ORDER BY 1`,
    [role],
  );
  return result.rows.map((row) => row.grant);
}

const grantsOn = (tables: readonly string[], privileges: readonly string[]): string[] =>
  tables.flatMap((table) => privileges.map((privilege) => `${table} ${privilege}`));

const WORKER_PURGED = RETENTION.filter((rule) => rule.purgedByWorker).map((rule) => `${rule.schema}.${rule.table}`);
const WORKER_KEPT = ["app.screening_pause", "app.smtp_pause", "app.worker_status"];

describe("worker role", () => {
  it("may change its own tables, delete only from the tables its purge covers, and read the config", async () => {
    const expected = [
      ...grantsOn(WORKER_PURGED, ["SELECT", "INSERT", "UPDATE", "DELETE"]),
      ...grantsOn(WORKER_KEPT, ["SELECT", "INSERT", "UPDATE"]),
      ...grantsOn(["app.feed", "app.segment_rule"], ["SELECT"]),
      ...grantsOn(["app.ebay_quota_window", "app.api_usage_hourly"], ["SELECT", "INSERT", "UPDATE"]),
    ].sort();

    expect(WORKER_PURGED.length).toBe(14);
    expect(await tableGrants("worker")).toEqual(expected);
  });
});

// "schema.table.column PRIVILEGE" for every column-level grant to the role.
async function columnGrants(role: string): Promise<string[]> {
  const result = await database.pool.query<{ grant: string }>(
    `SELECT n.nspname || '.' || c.relname || '.' || at.attname || ' ' || a.privilege_type AS grant
       FROM pg_attribute at
       JOIN pg_class c ON c.oid = at.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(at.attacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
      ORDER BY 1`,
    [role],
  );
  return result.rows.map((row) => row.grant);
}

const columnsOf = (table: string, columns: readonly string[]): string[] =>
  columns.map((column) => `${table}.${column} SELECT`);

describe("dashboard role", () => {
  it("may read exactly the tables and columns of section 8.2", async () => {
    const tables = [
      "app.feed",
      "app.segment_rule",
      "app.poll_run",
      "app.candidate",
      "app.screening",
      "app.llm_usage_daily",
      "app.alert",
      "app.alert_delivery",
      "app.price_sample",
      "app.purge_run",
      "app.worker_status",
      "app.screening_pause",
      "app.smtp_pause",
      "app.api_usage_hourly",
      "ebay_live.classifier_sample",
      "ebay_live.screening_text",
    ];
    const columns = [
      ...columnsOf("app.seen_item", ["feed_id", "segment", "outcome", "first_seen_at", "last_seen_at"]),
      ...columnsOf("app.ebay_quota_window", [
        "resource",
        "window_start",
        "window_end",
        "limit_total",
        "used",
        "used_alert_path",
        "used_standard",
      ]),
      ...columnsOf("ebay_live.listing", ["id", "legacy_item_id", "segment", "content_expires_at", "gone_at"]),
      ...columnsOf("ebay_live.listing_content", ["listing_id", "title", "content_expires_at"]),
    ];

    expect(await tableGrants("dashboard")).toEqual(grantsOn(tables, ["SELECT"]).sort());
    expect(await columnGrants("dashboard")).toEqual(columns.sort());
    expect(await columnGrants("worker")).toEqual([]);
  });
});

async function asRole(role: string, statement: string): Promise<unknown> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(statement);
    return null;
  } catch (error) {
    return error;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("both roles", () => {
  it("use both schemas, keep their role defaults, and are refused what section 2.5 leaves out", async () => {
    const settings = await database.pool.query<{ rolname: string; rolconfig: string[]; rolcanlogin: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolconfig, rolcanlogin, rolsuper FROM pg_roles WHERE rolname IN ('worker', 'dashboard') ORDER BY rolname",
    );
    const execute = await database.pool.query<{ worker: boolean; dashboard: boolean }>(
      `SELECT has_function_privilege('worker', 'app.reserve_ebay_call(text, text, text, integer, timestamptz)', 'EXECUTE') AS worker,
              has_schema_privilege('dashboard', 'ebay_live', 'USAGE') AND has_schema_privilege('worker', 'ebay_live', 'USAGE')
                AND NOT has_schema_privilege('dashboard', 'app', 'CREATE') AS dashboard`,
    );

    expect(settings.rows.map((row) => [row.rolname, [...row.rolconfig].sort(), row.rolsuper])).toEqual([
      ["dashboard", ["default_transaction_read_only=on", "statement_timeout=2s"], false],
      ["worker", ["statement_timeout=10s"], false],
    ]);
    expect(execute.rows[0]).toEqual({ worker: true, dashboard: true });
    for (const [role, statement] of [
      ["dashboard", "INSERT INTO app.feed (id, category_id, q, price_ceiling_cents, condition_ids, day_interval_s, night_interval_s) VALUES ('gpu', '1', 'x', 1, '{}', 60, 60)"],
      ["dashboard", "SELECT * FROM app.deletion_event"],
      ["dashboard", "SELECT item_key FROM app.seen_item"],
      ["dashboard", "SELECT item_key FROM ebay_live.listing"],
      ["dashboard", "SELECT subject FROM ebay_live.alert_message"],
      ["dashboard", "SELECT * FROM app.audit_event"],
      ["worker", "SELECT * FROM app.deletion_event"],
      ["worker", "SELECT * FROM app.audit_event"],
      ["worker", "UPDATE app.segment_rule SET enabled = false"],
      ["worker", "DELETE FROM app.worker_status"],
      ["worker", "DELETE FROM app.api_usage_hourly"],
    ] as const) {
      expect(await asRole(role, statement), `${role}: ${statement}`).toMatchObject({ code: "42501" });
    }
  });

  it("runs every dashboard query as dashboard in a read-only transaction", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL ROLE dashboard");
      const now = new Date("2026-10-21T12:00:00.000Z");
      const queries = DASHBOARD_QUERIES;

      expect(Object.keys(queries).sort()).toEqual(["alerts", "blocked", "candidates", "overview", "prices", "rejections", "screenings"]);
      for (const [name, query] of Object.entries(queries)) {
        await expect(query(client, now), name).resolves.toBeDefined();
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
