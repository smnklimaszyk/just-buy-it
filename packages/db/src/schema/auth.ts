import { sql } from "drizzle-orm";
import {
  char,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { ts } from "../columns.js";
import { codeFormat, id, oneOf } from "./helpers.js";

// People, codes and sessions of the sign-in (spec 2.6, ADR 0038). Class 3 (ADR 0014). Role web
// writes these tables but never deletes from them; the worker's purge does.
export const auth = pgSchema("auth");

// Spec 7.12. A new event needs a migration that widens auth_event_event_known (ADR 0005).
const AUTH_EVENTS = [
  "login_code_requested",
  "login_code_capped",
  "login_succeeded",
  "login_failed",
  "login_locked",
  "login_mail_failed",
  "session_ended",
  "sign_out_everywhere",
  "login_code_cli",
  "device_revoked",
];

// Case-insensitive text from the citext extension, created in migration 0009.
const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const appUser = auth.table(
  "app_user",
  {
    id: id(),
    email: citext("email").notNull().unique(),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by"),
    disabledAt: ts("disabled_at"),
  },
  (table) => [
    // The full address rules (trim, NFC, lower case) are applied in code before the insert.
    check("app_user_email_format", sql`char_length(${table.email}) <= 254 AND ${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
    check("app_user_role_known", oneOf(table.role, ["admin", "editor"])),
    check("app_user_status_known", oneOf(table.status, ["active", "disabled"])),
    check("app_user_disabled_at", sql`(${table.status} = 'disabled') = (${table.disabledAt} IS NOT NULL)`),
  ],
);

// One row per code request, also for unknown and disabled addresses (their code is never sent).
// Addresses and codes are stored only as HMACs. Purged after 24 h.
export const loginAttempt = auth.table(
  "login_attempt",
  {
    id: id(),
    // Shown on the code page and asked for by `ops auth code --ref` (spec 7.8).
    ref: char("ref", { length: 4 }).notNull(),
    attemptHash: text("attempt_hash").notNull().unique(),
    userId: uuid("user_id").references(() => appUser.id),
    // SET NULL, so the purge can delete a device whatever attempts still name it.
    deviceId: uuid("device_id").references(() => device.id, { onDelete: "set null" }),
    emailMac: text("email_mac").notNull(),
    codeMac: text("code_mac").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    failedTries: smallint("failed_tries").notNull().default(0),
    usedAt: ts("used_at"),
    closedAt: ts("closed_at"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    // "At most 3 live codes per address" and the CLI lookup by reference.
    index("login_attempt_email_mac_created_idx").on(table.emailMac, table.createdAt),
    index("login_attempt_ref_created_idx").on(table.ref, table.createdAt),
    check("login_attempt_ref_format", sql`${table.ref} ~ '^[ACDEFHJKMNPQRTUVWXY34679]{4}$'`),
    check("login_attempt_failed_tries_range", sql`${table.failedTries} BETWEEN 0 AND 3`),
  ],
);

// The token is stored as SHA-256. 24 h idle, 7 days absolute. Ended rows purged after 30 days.
export const session = auth.table(
  "session",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    csrfSecret: text("csrf_secret").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    endedAt: ts("ended_at"),
    endReason: text("end_reason"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    // logout, idle, absolute, admin, role_change, disabled (spec 7.12) and the ends web adds.
    check(
      "session_ended_reason",
      sql`(${table.endedAt} IS NULL) = (${table.endReason} IS NULL) AND (${table.endReason} IS NULL OR ${codeFormat(table.endReason)})`,
    ),
  ],
);

// The device cookie of spec 7.5, stored as SHA-256 and owned by one person. Purged 30 days after
// revoke or 180 days unused.
export const device = auth.table(
  "device",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (table) => [index("device_user_id_idx").on(table.userId)],
);

// Fixed-window counters of spec 7.5, taken with an upsert that only increments below the limit.
// Keys carry HMACs, never a plain address or IP. Purged after 2 days.
export const rateCounter = auth.table(
  "rate_counter",
  {
    key: text("key").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    check("rate_counter_key_length", sql`char_length(${table.key}) BETWEEN 1 AND 200`),
    check("rate_counter_count", sql`${table.count} >= 0`),
  ],
);

// The sign-in record shown on the Activity page. Kept 90 days (IP addresses for rate limits and
// security). An unknown address appears only as its HMAC.
export const authEvent = auth.table(
  "auth_event",
  {
    id: id(),
    at: ts("at").notNull(),
    event: text("event").notNull(),
    userId: uuid("user_id"),
    emailMac: text("email_mac"),
    ip: inet("ip"),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    // The Activity page and the 90-day purge read by time.
    index("auth_event_at_idx").on(table.at),
    check("auth_event_event_known", oneOf(table.event, AUTH_EVENTS)),
  ],
);
