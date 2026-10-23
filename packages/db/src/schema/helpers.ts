import { sql, type SQL } from "drizzle-orm";
import { uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

// `column IN ('a', 'b')` for a check constraint. The values are code constants, never input.
export const oneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

// A reason or outcome code as the domain writes it.
export const codeFormat = (column: AnyPgColumn): SQL => sql`${column} ~ '^[a-z][a-z0-9_]{0,39}$'`;

export const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);

// Condition groups of spec 2.1.1. "For parts" (7000) is never a group: it is never offered.
export const CONDITION_GROUPS = ["new", "open_box", "refurbished", "used"] as const;
