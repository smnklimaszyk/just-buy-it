import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { ts } from "../columns.js";
import { app } from "./app.js";
import { id, oneOf } from "./helpers.js";

// ---- Products as data (spec 2.1 to 2.3, ADR 0037). Money is integer cents. ---------------------

// 1 to 15 four-digit eBay condition IDs and no NULL entry (array_to_string skips NULLs).
const conditionIdsFormat = (column: AnyPgColumn) =>
  sql`cardinality(${column}) BETWEEN 1 AND 15 AND array_position(${column}, NULL) IS NULL AND array_to_string(${column}, ',') ~ '^[0-9]{4}(,[0-9]{4})*$'`;

// One row per watched product. Never deleted: history columns called `segment` hold its key.
export const product = app.table("product", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("draft"),
  categoryId: text("category_id").notNull(),
  categoryName: text("category_name"),
  conditionIds: text("condition_ids").array().notNull(),
  searchWords: text("search_words").array().notNull(),
  // A list of groups, each a list of entries: every group must match, inside a group any entry.
  mustWords: jsonb("must_words").notNull(),
  excludeWords: text("exclude_words").array().notNull().default(sql`'{}'::text[]`),
  warnWords: text("warn_words").array().notNull().default(sql`'{}'::text[]`),
  useDefaultJunk: boolean("use_default_junk").notNull().default(true),
  junkExceptions: text("junk_exceptions").array().notNull().default(sql`'{}'::text[]`),
  accessoryCheck: boolean("accessory_check").notNull().default(true),
  perGb: boolean("per_gb").notNull().default(false),
  unitMinTotal: integer("unit_min_total"),
  unitMaxTotal: integer("unit_max_total"),
  priceMode: text("price_mode").notNull(),
  // Fixed: the max landed price. Below market: the cap. Per GB when per_gb.
  maxCents: integer("max_cents").notNull(),
  belowMarketPct: smallint("below_market_pct"),
  floorCents: integer("floor_cents"),
  readCeilingCents: integer("read_ceiling_cents"),
  speed: text("speed").notNull().default("normal"),
  priceDropCheck: boolean("price_drop_check").notNull().default(false),
  sweepMinute: smallint("sweep_minute").notNull(),
  candidateCapPerDay: integer("candidate_cap_per_day").notNull().default(10),
  buyerProfile: text("buyer_profile").notNull(),
  claudeRequired: boolean("claude_required").notNull().default(false),
  // auth.app_user ids. Spec 2.1 calls it alert_user_ids; the name keeps clear of the user_id
  // guard of ADR 0013, which is about eBay users.
  alertRecipientIds: uuid("alert_recipient_ids").array().notNull().default(sql`'{}'::uuid[]`),
  version: integer("version").notNull().default(1),
  matchVersion: integer("match_version").notNull().default(1),
  watchFrom: ts("watch_from"),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (table) => [
  check("product_key_format", sql`${table.key} ~ '^[a-z][a-z0-9_]{1,39}$'`),
  check("product_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 60`),
  check("product_description_length", sql`char_length(${table.description}) BETWEEN 1 AND 300`),
  // Name and description reach Claude inside the <product> element (spec 4.2).
  check("product_no_markup", sql`position('<' in ${table.name}) = 0 AND position('<' in ${table.description}) = 0`),
  check("product_status_known", oneOf(table.status, ["draft", "active", "paused", "archived"])),
  check("product_category_id_format", sql`${table.categoryId} ~ '^[0-9]{1,12}$'`),
  check("product_condition_ids_format", conditionIdsFormat(table.conditionIds)),
  // 7000 is "for parts", never offered (spec 2.1.1).
  check("product_condition_ids_no_parts", sql`NOT ('7000' = ANY(${table.conditionIds}))`),
  // Word grammar is checked in code (spec 3.2): Postgres regex has no \p{L}.
  check(
    "product_list_sizes",
    sql`cardinality(${table.searchWords}) BETWEEN 1 AND 8 AND cardinality(${table.excludeWords}) <= 60 AND cardinality(${table.warnWords}) <= 30 AND cardinality(${table.junkExceptions}) <= 20 AND cardinality(${table.alertRecipientIds}) <= 20`,
  ),
  // CASE, because jsonb_array_length raises on anything but an array.
  check(
    "product_must_words_shape",
    sql`CASE WHEN jsonb_typeof(${table.mustWords}) = 'array' THEN jsonb_array_length(${table.mustWords}) BETWEEN 1 AND 6 ELSE false END`,
  ),
  check(
    "product_per_gb_units",
    sql`NOT ${table.perGb} OR (${table.unitMinTotal} IS NOT NULL AND ${table.unitMaxTotal} IS NOT NULL AND ${table.unitMinTotal} > 0 AND ${table.unitMaxTotal} >= ${table.unitMinTotal})`,
  ),
  check("product_price_mode_known", oneOf(table.priceMode, ["fixed", "below_market"])),
  check(
    "product_below_market_pct",
    sql`(${table.priceMode} = 'below_market') = (${table.belowMarketPct} IS NOT NULL) AND (${table.belowMarketPct} IS NULL OR ${table.belowMarketPct} BETWEEN 1 AND 90)`,
  ),
  check("product_max_positive", sql`${table.maxCents} > 0`),
  check("product_floor_range", sql`${table.floorCents} IS NULL OR (${table.floorCents} > 0 AND ${table.floorCents} <= ${table.maxCents})`),
  check("product_read_ceiling_positive", sql`${table.readCeilingCents} IS NULL OR ${table.readCeilingCents} > 0`),
  check("product_speed_known", oneOf(table.speed, ["fast", "normal", "slow"])),
  check("product_sweep_minute_range", sql`${table.sweepMinute} BETWEEN 0 AND 59`),
  check("product_candidate_cap_range", sql`${table.candidateCapPerDay} BETWEEN 0 AND 200`),
  check("product_buyer_profile_known", oneOf(table.buyerProfile, ["company", "private"])),
  check("product_versions_positive", sql`${table.version} >= 1 AND ${table.matchVersion} >= 1`),
]);

// Which sources watch a product. Every product has an ebay row.
export const productSource = app.table(
  "product_source",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    source: text("source").notNull(),
    enabled: boolean("enabled").notNull(),
    kaSavedSearchId: text("ka_saved_search_id"),
    kaPriceLimitCents: integer("ka_price_limit_cents"),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.source] }),
    check("product_source_source_known", oneOf(table.source, ["ebay", "kleinanzeigen"])),
    check(
      "product_source_ka_fields",
      sql`(${table.source} = 'kleinanzeigen' OR (${table.kaSavedSearchId} IS NULL AND ${table.kaPriceLimitCents} IS NULL)) AND (${table.kaPriceLimitCents} IS NULL OR ${table.kaPriceLimitCents} > 0)`,
    ),
  ],
);

// Append-only copy of the product row at each write, so a candidate's product_version can always
// be looked up.
export const productRevision = app.table(
  "product_revision",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    version: integer("version").notNull(),
    rules: jsonb("rules").notNull(),
    actor: text("actor").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.productId, table.version] }),
    check("product_revision_version_positive", sql`${table.version} >= 1`),
    check("product_revision_actor_format", sql`${table.actor} ~ '^[a-z]+:[a-z0-9_-]{1,40}$'`),
  ],
);

// Search ids are 's' || nextval: they only go up and are never reused (spec 2.3).
export const searchIdSeq = app.sequence("search_id_seq");

// A Browse search derived from the products by the planner, never edited by hand. A search that
// loses all members gets retired_at and is never deleted.
export const search = app.table(
  "search",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id").notNull(),
    conditionIds: text("condition_ids").array().notNull(),
    q: text("q").notNull(),
    floorEur: integer("floor_eur").notNull(),
    ceilingEur: integer("ceiling_eur").notNull(),
    dayIntervalS: integer("day_interval_s").notNull(),
    nightIntervalS: integer("night_interval_s").notNull(),
    enabled: boolean("enabled").notNull(),
    retiredAt: ts("retired_at"),
    membersHash: text("members_hash").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("search_id_format", sql`${table.id} ~ '^s[1-9][0-9]{0,17}$'`),
    check("search_category_id_format", sql`${table.categoryId} ~ '^[0-9]{1,12}$'`),
    check("search_condition_ids_format", conditionIdsFormat(table.conditionIds)),
    check("search_intervals", sql`${table.dayIntervalS} >= 60 AND ${table.nightIntervalS} >= 60`),
    check("search_price_range", sql`${table.floorEur} >= 0 AND ${table.ceilingEur} >= ${table.floorEur}`),
  ],
);

// Which products a search serves. Rewritten (DELETE and INSERT) with every save.
export const searchProduct = app.table(
  "search_product",
  {
    searchId: text("search_id")
      .notNull()
      .references(() => search.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
  },
  (table) => [primaryKey({ columns: [table.searchId, table.productId] })],
);
