import { timestamp } from "drizzle-orm/pg-core";

// ADR 0008: every timestamp is timestamptz(3), read and written as a Date.
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
