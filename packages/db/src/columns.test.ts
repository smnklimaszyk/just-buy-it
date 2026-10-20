import { describe, expect, it } from "vitest";
import { getTableConfig, pgTable } from "drizzle-orm/pg-core";
import { ts } from "./columns.js";

describe("ts", () => {
  it("is a timestamptz with millisecond precision read as a Date", () => {
    const table = pgTable("example", { at: ts("at") });
    const [column] = getTableConfig(table).columns;

    expect(column?.getSQLType()).toBe("timestamp (3) with time zone");
    expect(column?.columnType).toBe("PgTimestamp");
  });
});
