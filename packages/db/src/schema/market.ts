import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ts } from "../columns.js";
import { app } from "./app.js";
import { CONDITION_GROUPS, codeFormat, id, oneOf } from "./helpers.js";
import { product } from "./product.js";

// ---- Market value from asking prices (spec 2.4, ADR 0040). Aggregates and prices only. ---------

const SOURCES = ["ebay", "kleinanzeigen"];

const REQUEST_STATUSES = ["open", "queued", "running", "done", "refused"];

// The product's own matching listings of the last 30 days. No title, seller or listing ID.
export const marketListing = app.table(
  "market_listing",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    matchVersion: integer("match_version").notNull(),
    source: text("source").notNull(),
    itemKey: text("item_key").notNull(),
    // NULL only for an excluded listing whose condition maps to no group.
    conditionGroup: text("condition_group"),
    landedCents: integer("landed_cents").notNull(),
    unitTotal: integer("unit_total"),
    originAt: ts("origin_at"),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    bestOffer: boolean("best_offer").notNull(),
    excludedReason: text("excluded_reason"),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.source, table.itemKey] }),
    check("market_listing_item_key_format", sql`${table.itemKey} ~ '^[0-9a-f]{64}$'`),
    check("market_listing_source_known", oneOf(table.source, SOURCES)),
    check(
      "market_listing_condition_group_known",
      sql`CASE WHEN ${table.conditionGroup} IS NULL THEN ${table.excludedReason} IS NOT NULL ELSE ${oneOf(table.conditionGroup, CONDITION_GROUPS)} END`,
    ),
    check("market_listing_excluded_reason_format", sql`${table.excludedReason} IS NULL OR ${codeFormat(table.excludedReason)}`),
    check(
      "market_listing_counts",
      sql`${table.landedCents} >= 0 AND ${table.matchVersion} >= 1 AND (${table.unitTotal} IS NULL OR ${table.unitTotal} > 0)`,
    ),
  ],
);

// One computed value per product, condition group and run. "Out of date" is worked out when read.
// The price columns are set to NULL after 30 days; the row is kept 1 year.
export const marketValue = app.table(
  "market_value",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    conditionGroup: text("condition_group").notNull(),
    matchVersion: integer("match_version").notNull(),
    computedAt: ts("computed_at").notNull(),
    methodVersion: text("method_version").notNull(),
    status: text("status").notNull(),
    capped: boolean("capped").notNull(),
    n: integer("n").notNull(),
    neff: numeric("neff").notNull(),
    mCents: integer("m_cents"),
    p25Cents: integer("p25_cents"),
    p75Cents: integer("p75_cents"),
    loCents: integer("lo_cents"),
    hiCents: integer("hi_cents"),
    halfWidth: numeric("half_width"),
    bestOfferShare: numeric("best_offer_share"),
    valueCents: integer("value_cents"),
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [
    // "Newest ok value of this group and match_version before a time" (spec 6.4).
    index("market_value_lookup_idx").on(table.productId, table.conditionGroup, table.matchVersion, table.computedAt.desc()),
    check("market_value_condition_group_known", oneOf(table.conditionGroup, CONDITION_GROUPS)),
    check("market_value_status_known", oneOf(table.status, ["none", "rough", "ok"])),
    check("market_value_counts", sql`${table.n} >= 0 AND ${table.neff} >= 0 AND ${table.matchVersion} >= 1`),
  ],
);

// A request for a market snapshot from the form or a save; poll-tick turns it into a job.
export const marketRequest = app.table(
  "market_request",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    requestedBy: uuid("requested_by"),
    reason: text("reason").notNull(),
    requestedAt: ts("requested_at").notNull(),
    status: text("status").notNull().default("open"),
    doneAt: ts("done_at"),
  },
  (table) => [
    uniqueIndex("market_request_one_open")
      .on(table.productId)
      .where(sql`${table.status} IN ('open', 'queued', 'running')`),
    check("market_request_reason_known", oneOf(table.reason, ["created", "rules_changed", "check_now"])),
    check("market_request_status_known", oneOf(table.status, REQUEST_STATUSES)),
    check("market_request_done_at", sql`(${table.status} IN ('done', 'refused')) = (${table.doneAt} IS NOT NULL)`),
  ],
);

// "Suggest category" from the form: the worker answers with up to 5 categories in result.
export const categoryRequest = app.table(
  "category_request",
  {
    id: id(),
    requestedBy: uuid("requested_by"),
    q: text("q").notNull(),
    status: text("status").notNull().default("open"),
    result: jsonb("result"),
    createdAt: ts("created_at").notNull().defaultNow(),
    doneAt: ts("done_at"),
  },
  (table) => [
    check("category_request_q_length", sql`char_length(${table.q}) BETWEEN 1 AND 200`),
    check("category_request_status_known", oneOf(table.status, REQUEST_STATUSES)),
    check("category_request_done_at", sql`(${table.status} IN ('done', 'refused')) = (${table.doneAt} IS NOT NULL)`),
  ],
);

// Snapshots outside the nightly run per Berlin day, for the global cap (spec 5.4).
export const marketDaily = app.table(
  "market_daily",
  {
    dayBerlin: date("day_berlin", { mode: "string" }).primaryKey(),
    extraSnapshots: integer("extra_snapshots").notNull().default(0),
  },
  (table) => [check("market_daily_extra_snapshots", sql`${table.extraSnapshots} >= 0`)],
);

// One row per market snapshot run: calls, pages and Browse's total, never listing data.
export const marketRun = app.table(
  "market_run",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
    // discarded: the product's match_version changed during the run, so no value was written.
    status: text("status").notNull().default("running"),
    calls: integer("calls").notNull().default(0),
    pages: integer("pages").notNull().default(0),
    total: integer("total"),
    errorKind: text("error_kind"),
  },
  (table) => [
    check("market_run_status_known", oneOf(table.status, ["running", "ok", "error", "quota_refused", "discarded"])),
    check("market_run_finished_unless_running", sql`(${table.status} = 'running') = (${table.finishedAt} IS NULL)`),
    check("market_run_error_kind_format", sql`${table.errorKind} IS NULL OR ${codeFormat(table.errorKind)}`),
    check(
      "market_run_counts",
      sql`${table.calls} >= 0 AND ${table.pages} >= 0 AND (${table.total} IS NULL OR ${table.total} >= 0)`,
    ),
  ],
);
