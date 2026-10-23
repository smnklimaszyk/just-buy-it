import { sql } from "drizzle-orm";
import { check, integer, jsonb, text, uuid } from "drizzle-orm/pg-core";
import { ts } from "../columns.js";
import { app } from "./app.js";

// Platform settings (spec 2.5). A missing row is the code default; each key has a Zod schema in
// packages/domain/src/settings.ts. Every save writes app.audit_event and bumps version.
export const setting = app.table(
  "setting",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // "claude.model", "alerts.per_hour", "matcher.low_feedback_below".
    check("setting_key_format", sql`${table.key} ~ '^[a-z][a-z0-9_]{0,30}\\.[a-z][a-z0-9_]{0,40}$'`),
    check("setting_version_positive", sql`${table.version} >= 1`),
  ],
);
