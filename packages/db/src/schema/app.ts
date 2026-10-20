import { sql } from "drizzle-orm";
import { check, integer, pgSchema, primaryKey, smallint, text, uuid } from "drizzle-orm/pg-core";
import { ts } from "../columns.js";

export const app = pgSchema("app");

// One row per eBay pool and 24-hour window. Windows of one resource never overlap: the exclusion
// constraint is in migration 0001, because drizzle-kit cannot express EXCLUDE.
export const ebayQuotaWindow = app.table(
  "ebay_quota_window",
  {
    resource: text("resource").notNull(),
    windowStart: ts("window_start").notNull(),
    windowEnd: ts("window_end").notNull(),
    limitTotal: integer("limit_total").notNull().default(5000),
    used: integer("used").notNull().default(0),
    usedAlertPath: integer("used_alert_path").notNull().default(0),
    usedStandard: integer("used_standard").notNull().default(0),
    ebayOffset: integer("ebay_offset").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.resource, table.windowStart] }),
    check("ebay_quota_window_resource_format", sql`${table.resource} ~ '^[a-z]+\\.[a-z_.]+$'`),
    check("ebay_quota_window_bounds", sql`${table.windowEnd} > ${table.windowStart}`),
    check(
      "ebay_quota_window_counts",
      sql`${table.limitTotal} > 0 AND ${table.used} >= 0 AND ${table.ebayOffset} >= 0`,
    ),
    check("ebay_quota_window_used_sum", sql`${table.used} = ${table.usedAlertPath} + ${table.usedStandard}`),
  ],
);

export const apiUsageHourly = app.table(
  "api_usage_hourly",
  {
    hourUtc: ts("hour_utc").notNull(),
    resource: text("resource").notNull(),
    purpose: text("purpose").notNull(),
    calls: integer("calls").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hourUtc, table.resource, table.purpose] }),
    check("api_usage_hourly_purpose_format", sql`${table.purpose} ~ '^[a-z][a-z0-9_-]{0,39}$'`),
    check("api_usage_hourly_calls_positive", sql`${table.calls} > 0`),
    check("api_usage_hourly_whole_hour", sql`extract(epoch FROM ${table.hourUtc})::bigint % 3600 = 0`),
  ],
);

// ADR 0013: no username, userId, eiasToken or body.
export const deletionEvent = app.table(
  "deletion_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    notificationId: text("notification_id").notNull().unique(),
    topic: text("topic").notNull(),
    eventDate: ts("event_date").notNull(),
    publishAttemptCount: integer("publish_attempt_count").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("deletion_event_notification_id_length", sql`char_length(${table.notificationId}) BETWEEN 1 AND 128`),
    check("deletion_event_topic_length", sql`char_length(${table.topic}) BETWEEN 1 AND 64`),
    check("deletion_event_publish_attempt_count", sql`${table.publishAttemptCount} >= 0`),
  ],
);

export const deletionResultHourly = app.table(
  "deletion_result_hourly",
  {
    hourUtc: ts("hour_utc").notNull(),
    result: text("result").notNull(),
    notifications: integer("notifications").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hourUtc, table.result] }),
    check("deletion_result_hourly_result_format", sql`${table.result} ~ '^[a-z][a-z_]{0,39}$'`),
    check("deletion_result_hourly_notifications_positive", sql`${table.notifications} > 0`),
    check("deletion_result_hourly_whole_hour", sql`extract(epoch FROM ${table.hourUtc})::bigint % 3600 = 0`),
  ],
);

// One row, overwritten on each probe request (ADR 0030). seen_at comes from the server's clock.
export const probeSeen = app.table(
  "probe_seen",
  {
    id: smallint("id").primaryKey().default(1),
    seenAt: ts("seen_at").notNull(),
  },
  (table) => [check("probe_seen_single_row", sql`${table.id} = 1`)],
);
