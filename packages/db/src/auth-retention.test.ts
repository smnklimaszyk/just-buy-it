import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { AUTH_RETENTION } from "./retention.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// ADR 0038: the auth tables and their lifetimes. Web writes them, the worker purges them.

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

describe("auth retention registry", () => {
  it("has one row per auth table, marks every numeric column and names purge keys that exist", async () => {
    const tables = await database.pool.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'auth' AND table_type = 'BASE TABLE' ORDER BY 1",
    );
    const columns = await database.pool.query<{ name: string; numeric: boolean }>(
      `SELECT table_name || '.' || column_name AS name,
              data_type IN ('smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision') AS numeric
         FROM information_schema.columns WHERE table_schema = 'auth'`,
    );
    const names = new Set(columns.rows.map((column) => column.name));

    expect(AUTH_RETENTION.map((rule) => rule.table).sort()).toEqual(tables.rows.map((row) => row.name));
    expect(AUTH_RETENTION.flatMap((rule) => rule.otherNumericColumns.map((c) => `${rule.table}.${c}`)).sort()).toEqual(
      columns.rows.filter((column) => column.numeric).map((column) => column.name).sort(),
    );
    expect(AUTH_RETENTION.filter((rule) => rule.purgeKey !== null && !names.has(`${rule.table}.${rule.purgeKey}`))).toEqual([]);
    expect(AUTH_RETENTION.filter((rule) => rule.schema !== "auth" || rule.class !== 3 || rule.owner !== "web")).toEqual([]);
    expect(AUTH_RETENTION.filter((rule) => rule.purgedByWorker).map((rule) => rule.table).sort()).toEqual([
      "auth_event",
      "device",
      "login_attempt",
      "rate_counter",
      "session",
    ]);
  });
});
