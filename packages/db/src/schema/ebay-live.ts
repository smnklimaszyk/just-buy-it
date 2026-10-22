import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { ts } from "../columns.js";

// Class 1: eBay content and raw IDs (ADR 0014). Every row here is deleted by the worker's purge,
// and no table outside this schema has a foreign key into it.
export const ebayLive = pgSchema("ebay_live");

// One row per candidate item. Deleted at gone_at, which cascades to listing_content.
export const listing = ebayLive.table(
  "listing",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    itemKey: text("item_key").notNull().unique(),
    keyVersion: smallint("key_version").notNull(),
    itemId: text("item_id").notNull(),
    legacyItemId: text("legacy_item_id").notNull(),
    feedId: text("feed_id").notNull(),
    segment: text("segment").notNull(),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastConfirmedAt: ts("last_confirmed_at").notNull(),
    itemCreationAt: ts("item_creation_at"),
    itemEndAt: ts("item_end_at"),
    contentExpiresAt: ts("content_expires_at").notNull(),
    goneAt: ts("gone_at"),
    goneReason: text("gone_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("listing_content_expires_at_idx").on(table.contentExpiresAt),
    index("listing_gone_at_idx").on(table.goneAt),
    index("listing_last_confirmed_at_idx").on(table.lastConfirmedAt),
    check("listing_legacy_item_id_format", sql`${table.legacyItemId} ~ '^[0-9]{1,20}$'`),
    check(
      "listing_gone_reason_known",
      sql`(${table.goneAt} IS NULL) = (${table.goneReason} IS NULL) AND (${table.goneReason} IS NULL OR ${table.goneReason} IN ('ended', 'unconfirmed', 'not_found'))`,
    ),
  ],
);

// The listing's content: from the summary, then from getItem. Deleted at content_expires_at.
export const listingContent = ebayLive.table(
  "listing_content",
  {
    listingId: uuid("listing_id")
      .primaryKey()
      .references(() => listing.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    title: text("title").notNull(),
    condition: text("condition"),
    conditionDescription: text("condition_description"),
    sellerFeedbackScore: integer("seller_feedback_score"),
    sellerFeedbackPct: doublePrecision("seller_feedback_pct"),
    sellerAccountType: text("seller_account_type"),
    returnsAccepted: boolean("returns_accepted"),
    returnsDays: integer("returns_days"),
    itemLocationCountry: text("item_location_country"),
    // Item specifics as [{ name, value }], cut as sent to Claude.
    aspects: jsonb("aspects"),
    // Cleaned and masked, as sent to Claude.
    descriptionText: text("description_text"),
    imageCount: integer("image_count"),
    fetchedAt: ts("fetched_at").notNull(),
    contentExpiresAt: ts("content_expires_at").notNull(),
  },
  (table) => [
    index("listing_content_content_expires_at_idx").on(table.contentExpiresAt),
    check("listing_content_source_known", sql`${table.source} IN ('summary', 'item')`),
    check(
      "listing_content_seller_account_type_known",
      sql`${table.sellerAccountType} IS NULL OR ${table.sellerAccountType} IN ('business', 'private')`,
    ),
  ],
);

// Per feed and hour the first 20 rejected and all accepted titles, for the owner's review (6 h).
export const classifierSample = ebayLive.table(
  "classifier_sample",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    feedId: text("feed_id").notNull(),
    segment: text("segment"),
    title: text("title").notNull(),
    landedCents: integer("landed_cents"),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    seenAt: ts("seen_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
  },
  (table) => [
    index("classifier_sample_expires_at_idx").on(table.expiresAt),
    index("classifier_sample_feed_seen_at_idx").on(table.feedId, table.seenAt),
    check("classifier_sample_outcome_known", sql`${table.outcome} IN ('candidate', 'rejected')`),
    check("classifier_sample_reason_for_rejections", sql`(${table.outcome} = 'rejected') = (${table.reason} IS NOT NULL)`),
  ],
);

// Claude's reason text: written from listing content, so it expires with the content.
export const screeningText = ebayLive.table(
  "screening_text",
  {
    screeningId: uuid("screening_id").primaryKey(),
    reason: text("reason").notNull(),
    expiresAt: ts("expires_at").notNull(),
  },
  (table) => [index("screening_text_expires_at_idx").on(table.expiresAt)],
);

// The rendered email of one delivery. A pending delivery without its message is never sent.
export const alertMessage = ebayLive.table(
  "alert_message",
  {
    deliveryId: uuid("delivery_id").primaryKey(),
    subject: text("subject").notNull(),
    textBody: text("text_body").notNull(),
    htmlBody: text("html_body").notNull(),
    expiresAt: ts("expires_at").notNull(),
  },
  (table) => [index("alert_message_expires_at_idx").on(table.expiresAt)],
);
