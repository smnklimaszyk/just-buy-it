import type { SellerAccountType } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

// v2 writes the search id (poll) or the product key (sweep) into feed_id and the product key into
// segment. Rows written before v2 hold a feed id and a segment.
export type ListingInput = {
  itemKey: string;
  keyVersion: number;
  itemId: string;
  legacyItemId: string;
  feedId: string;
  segment: string;
  firstSeenAt: Date;
  itemCreationAt: Date | null;
  itemEndAt: Date | null;
  // A summary-only listing: min(first_seen_at + 6 h, item end).
  contentExpiresAt: Date;
};

export type Aspect = { name: string; value: string };

export type ListingContentInput = {
  source: "summary" | "item";
  title: string;
  condition: string | null;
  conditionDescription: string | null;
  sellerFeedbackScore: number | null;
  sellerFeedbackPct: number | null;
  sellerAccountType: SellerAccountType | null;
  returnsAccepted: boolean | null;
  returnsDays: number | null;
  itemLocationCountry: string | null;
  aspects: Aspect[] | null;
  // Cleaned and masked, as sent to Claude.
  descriptionText: string | null;
  imageCount: number | null;
  fetchedAt: Date;
  // min(fetched_at + 6 h, item end).
  contentExpiresAt: Date;
};

export type GoneReason = "ended" | "unconfirmed" | "not_found";

export type Listing = {
  id: string;
  itemKey: string;
  keyVersion: number;
  itemId: string;
  legacyItemId: string;
  feedId: string;
  segment: string;
  firstSeenAt: Date;
  lastConfirmedAt: Date;
  itemCreationAt: Date | null;
  itemEndAt: Date | null;
  contentExpiresAt: Date;
  goneAt: Date | null;
  goneReason: GoneReason | null;
  // null once the content expired (or before it was written).
  content: ListingContentInput | null;
};

// In the poll or sweep transaction, for a key claimCandidate returned true for.
export async function insertListing(db: Queryable, input: ListingInput): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO ebay_live.listing
       (item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at, last_confirmed_at,
        item_creation_at, item_end_at, content_expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $7, $7)
     RETURNING id`,
    [
      input.itemKey,
      input.keyVersion,
      input.itemId,
      input.legacyItemId,
      input.feedId,
      input.segment,
      input.firstSeenAt,
      input.itemCreationAt,
      input.itemEndAt,
      input.contentExpiresAt,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("listing insert returned no row");
  return id;
}

// Keyed on listing_id: the getItem content replaces the summary content. The listing's
// content_expires_at follows, so the dashboard and the purge agree.
export async function upsertListingContent(db: Queryable, listingId: string, content: ListingContentInput): Promise<void> {
  await db.query(
    `WITH c AS (
       INSERT INTO ebay_live.listing_content AS lc
         (listing_id, source, title, condition, condition_description, seller_feedback_score, seller_feedback_pct,
          seller_account_type, returns_accepted, returns_days, item_location_country, aspects, description_text,
          image_count, fetched_at, content_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (listing_id) DO UPDATE SET
         source = EXCLUDED.source, title = EXCLUDED.title, condition = EXCLUDED.condition,
         condition_description = EXCLUDED.condition_description,
         seller_feedback_score = EXCLUDED.seller_feedback_score, seller_feedback_pct = EXCLUDED.seller_feedback_pct,
         seller_account_type = EXCLUDED.seller_account_type, returns_accepted = EXCLUDED.returns_accepted,
         returns_days = EXCLUDED.returns_days, item_location_country = EXCLUDED.item_location_country,
         aspects = EXCLUDED.aspects, description_text = EXCLUDED.description_text,
         image_count = EXCLUDED.image_count, fetched_at = EXCLUDED.fetched_at,
         content_expires_at = EXCLUDED.content_expires_at
       RETURNING listing_id
     )
     UPDATE ebay_live.listing l SET content_expires_at = $16, updated_at = $15
       FROM c WHERE l.id = c.listing_id`,
    [
      listingId,
      content.source,
      content.title,
      content.condition,
      content.conditionDescription,
      content.sellerFeedbackScore,
      content.sellerFeedbackPct,
      content.sellerAccountType,
      content.returnsAccepted,
      content.returnsDays,
      content.itemLocationCountry,
      // node-pg sends a JS array as a Postgres array; jsonb needs the JSON text.
      content.aspects === null ? null : JSON.stringify(content.aspects),
      content.descriptionText,
      content.imageCount,
      content.fetchedAt,
      content.contentExpiresAt,
    ],
  );
}

// A later sighting of a tracked listing (section 6.3). Unknown keys are ignored; the time never
// moves back.
export async function confirmListings(db: Queryable, itemKeys: readonly string[], at: Date): Promise<void> {
  if (itemKeys.length === 0) return;
  await db.query(
    `UPDATE ebay_live.listing
        SET last_confirmed_at = $2, updated_at = $2
      WHERE item_key = ANY($1) AND last_confirmed_at < $2 AND gone_at IS NULL`,
    [itemKeys, at],
  );
}

// getItem 404 or an ended item at enrich. Only the first call marks it (true); the purge deletes it.
export async function markListingGone(db: Queryable, listingId: string, reason: GoneReason, at: Date): Promise<boolean> {
  const result = await db.query(
    `UPDATE ebay_live.listing SET gone_at = $3, gone_reason = $2, updated_at = $3
      WHERE id = $1 AND gone_at IS NULL`,
    [listingId, reason, at],
  );
  return result.rowCount === 1;
}

type ListingRow = {
  id: string;
  item_key: string;
  key_version: number;
  item_id: string;
  legacy_item_id: string;
  feed_id: string;
  segment: string;
  first_seen_at: Date;
  last_confirmed_at: Date;
  item_creation_at: Date | null;
  item_end_at: Date | null;
  content_expires_at: Date;
  gone_at: Date | null;
  gone_reason: GoneReason | null;
  source: "summary" | "item" | null;
  title: string | null;
  condition: string | null;
  condition_description: string | null;
  seller_feedback_score: number | null;
  seller_feedback_pct: number | null;
  seller_account_type: SellerAccountType | null;
  returns_accepted: boolean | null;
  returns_days: number | null;
  item_location_country: string | null;
  aspects: Aspect[] | null;
  description_text: string | null;
  image_count: number | null;
  fetched_at: Date | null;
  c_expires_at: Date | null;
};

function toContent(row: ListingRow): ListingContentInput | null {
  if (row.source === null || row.title === null || row.fetched_at === null || row.c_expires_at === null) return null;
  return {
    source: row.source,
    title: row.title,
    condition: row.condition,
    conditionDescription: row.condition_description,
    sellerFeedbackScore: row.seller_feedback_score,
    sellerFeedbackPct: row.seller_feedback_pct,
    sellerAccountType: row.seller_account_type,
    returnsAccepted: row.returns_accepted,
    returnsDays: row.returns_days,
    itemLocationCountry: row.item_location_country,
    aspects: row.aspects,
    descriptionText: row.description_text,
    imageCount: row.image_count,
    fetchedAt: row.fetched_at,
    contentExpiresAt: row.c_expires_at,
  };
}

// The listing with its content, or null when the row is gone (deleted by the purge).
export async function getListing(db: Queryable, listingId: string): Promise<Listing | null> {
  const result = await db.query<ListingRow>(
    `SELECT l.id, l.item_key, l.key_version, l.item_id, l.legacy_item_id, l.feed_id, l.segment, l.first_seen_at,
            l.last_confirmed_at, l.item_creation_at, l.item_end_at, l.content_expires_at, l.gone_at, l.gone_reason,
            c.source, c.title, c.condition, c.condition_description, c.seller_feedback_score, c.seller_feedback_pct,
            c.seller_account_type, c.returns_accepted, c.returns_days, c.item_location_country, c.aspects,
            c.description_text, c.image_count, c.fetched_at, c.content_expires_at AS c_expires_at
       FROM ebay_live.listing l
       LEFT JOIN ebay_live.listing_content c ON c.listing_id = l.id
      WHERE l.id = $1`,
    [listingId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    itemKey: row.item_key,
    keyVersion: row.key_version,
    itemId: row.item_id,
    legacyItemId: row.legacy_item_id,
    feedId: row.feed_id,
    segment: row.segment,
    firstSeenAt: row.first_seen_at,
    lastConfirmedAt: row.last_confirmed_at,
    itemCreationAt: row.item_creation_at,
    itemEndAt: row.item_end_at,
    contentExpiresAt: row.content_expires_at,
    goneAt: row.gone_at,
    goneReason: row.gone_reason,
    content: toContent(row),
  };
}
