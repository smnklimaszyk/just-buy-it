import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { RETENTION } from "./retention.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Section 7.2: the retention registry covers every table, and the schema keeps the data rules.

const SCHEMAS = ["app", "ebay_live"];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

async function tables(): Promise<string[]> {
  const result = await database.pool.query<{ name: string }>(
    `SELECT table_schema || '.' || table_name AS name
       FROM information_schema.tables
      WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'
      ORDER BY 1`,
    [SCHEMAS],
  );
  return result.rows.map((row) => row.name);
}

const NUMERIC_TYPES = ["smallint", "integer", "bigint", "numeric", "real", "double precision"];

type Column = { table_schema: string; table_name: string; column_name: string; data_type: string };

async function columns(): Promise<Column[]> {
  const result = await database.pool.query<Column>(
    `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = ANY($1)
      ORDER BY table_schema, table_name, ordinal_position`,
    [SCHEMAS],
  );
  return result.rows;
}

const registered =(): string[] => RETENTION.map((rule) => `${rule.schema}.${rule.table}`).sort();

describe("retention registry", () => {
  it("has exactly one row per app and ebay_live table, including the listing pipeline tables", async () => {
    const all = await tables();

    expect(all).toContain("ebay_live.listing");
    expect(all).toContain("app.alert_delivery");
    expect(registered()).toEqual(all);
    expect(new Set(registered()).size).toBe(RETENTION.length);
  });

  it("marks every numeric column as price-bearing or not, and names only columns that exist", async () => {
    const all = await columns();
    const numeric = all
      .filter((column) => NUMERIC_TYPES.includes(column.data_type))
      .map((column) => `${column.table_schema}.${column.table_name}.${column.column_name}`)
      .sort();
    const marked = RETENTION.flatMap((rule) =>
      [...rule.priceColumns, ...rule.otherNumericColumns].map((column) => `${rule.schema}.${rule.table}.${column}`),
    ).sort();
    const names = new Set(all.map((c) => `${c.table_schema}.${c.table_name}.${c.column_name}`));
    const missingKeys = RETENTION.filter((rule) => rule.purgeKey !== null)
      .map((rule) => `${rule.schema}.${rule.table}.${rule.purgeKey ?? ""}`)
      .filter((column) => !names.has(column));

    expect(marked).toEqual(numeric);
    expect(missingKeys).toEqual([]);
  });

  it("lets the worker purge only its own tables and every ebay_live table, and keeps class 1 in ebay_live", () => {
    expect(RETENTION.filter((rule) => rule.purgedByWorker && rule.owner !== "worker")).toEqual([]);
    expect(RETENTION.filter((rule) => rule.schema === "ebay_live" && !rule.purgedByWorker)).toEqual([]);
    expect(RETENTION.filter((rule) => (rule.class === 1) !== (rule.schema === "ebay_live"))).toEqual([]);
    expect(RETENTION.filter((rule) => rule.priceNullAfterDays !== null && rule.priceColumns.length === 0)).toEqual([]);
  });
});

describe("schema data rules", () => {
  it("has no foreign key into ebay_live, no user or legal column, and no item IDs, titles or prices in seen_item", async () => {
    const foreignKeys = await database.pool.query<{ name: string }>(
      `SELECT c.conname AS name
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace tn ON tn.oid = t.relnamespace
         JOIN pg_class r ON r.oid = c.confrelid
         JOIN pg_namespace rn ON rn.oid = r.relnamespace
        WHERE c.contype = 'f' AND rn.nspname = 'ebay_live' AND tn.nspname <> 'ebay_live'`,
    );
    const all = await columns();
    const of = (table: string) =>
      all.filter((c) => c.table_schema === "app" && c.table_name === table).map((c) => c.column_name);

    expect(foreignKeys.rows).toEqual([]);
    expect(all.filter((c) => /username|user_id|eias|legal/i.test(c.column_name))).toEqual([]);
    for (const table of ["seen_item", "price_sample"]) {
      expect(of(table).length, table).toBeGreaterThan(0);
      expect(of(table).filter((name) => /item_id|legacy|title|url|seller/.test(name)), table).toEqual([]);
    }
    expect(of("price_sample")).not.toContain("item_key");
    expect(of("seen_item").filter((name) => /cents|price/.test(name))).toEqual([]);
  });
});
