import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// A13, database half: every timestamp is timestamptz(3) and survives the DST switch.

const OUR_SCHEMAS = ["app", "auth", "ebay_live"];

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

type Column = { table_schema: string; table_name: string; column_name: string; data_type: string };

async function columns(): Promise<Column[]> {
  const result = await database.pool.query<Column>(
    `SELECT table_schema, table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = ANY($1)
      ORDER BY table_schema, table_name, ordinal_position`,
    [OUR_SCHEMAS],
  );
  return result.rows;
}

describe("app schema", () => {
  it("has no timestamp without time zone", async () => {
    const all = await columns();

    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((column) => column.data_type === "timestamp without time zone")).toEqual([]);
  });

  it("gives every timestamptz millisecond precision", async () => {
    const result = await database.pool.query<{ column: string; precision: number }>(
      `SELECT table_name || '.' || column_name AS column, datetime_precision AS precision
         FROM information_schema.columns
        WHERE table_schema = ANY($1) AND data_type = 'timestamp with time zone'`,
      [OUR_SCHEMAS],
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.filter((row) => row.precision !== 3)).toEqual([]);
  });

  it("allows now() defaults only on created_at and updated_at", async () => {
    const result = await database.pool.query<{ column_name: string; column_default: string }>(
      `SELECT column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = ANY($1)
          AND (column_default ILIKE '%now()%' OR column_default ILIKE '%current_timestamp%')`,
      [OUR_SCHEMAS],
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.filter((row) => !["created_at", "updated_at"].includes(row.column_name))).toEqual([]);
  });

  it("defaults deletion_event.id to uuidv7()", async () => {
    const result = await database.pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'deletion_event' AND column_name = 'id'`,
    );

    expect(result.rows[0]?.column_default).toBe("uuidv7()");
  });

  it("has no column that names an eBay user (ADR 0013)", async () => {
    const all = await columns();

    expect(all.filter((column) => /username|eias|ebay_user/i.test(column.column_name))).toEqual([]);
  });

  it.each(["UTC", "Europe/Berlin"])(
    "stores 02:30 CEST and 02:30 CET as two distinct instants with session time zone %s",
    async (timeZone) => {
      const cest = new Date("2026-10-25T00:30:00Z");
      const cet = new Date("2026-10-25T01:30:00Z");
      const client = await database.pool.connect();
      try {
        await client.query(`SET timezone TO '${timeZone}'`);
        await client.query(
          `INSERT INTO app.deletion_event (notification_id, topic, event_date, publish_attempt_count)
           VALUES ($1, 'MARKETPLACE_ACCOUNT_DELETION', $2, 1), ($3, 'MARKETPLACE_ACCOUNT_DELETION', $4, 1)`,
          [`cest-${timeZone}`, cest, `cet-${timeZone}`, cet],
        );
        const result = await client.query<{ notification_id: string; event_date: Date }>(
          "SELECT notification_id, event_date FROM app.deletion_event WHERE notification_id = ANY($1) ORDER BY event_date",
          [[`cest-${timeZone}`, `cet-${timeZone}`]],
        );

        expect(result.rows.map((row) => row.event_date.toISOString())).toEqual([
          cest.toISOString(),
          cet.toISOString(),
        ]);
      } finally {
        client.release();
      }
    },
  );
});
