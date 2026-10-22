import type { CodeSignal, FeedId, ListingFlag, RejectReason, Segment } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

export type CandidateInput = {
  itemKey: string;
  listingId: string;
  feedId: FeedId;
  segment: Segment;
  source: "poll" | "sweep";
  priceCents: number;
  shippingCents: number | null;
  landedCents: number | null;
  shippingKnown: boolean;
  totalGb: number | null;
  ruleVersion: number;
  flags: ListingFlag[];
  createdAt: Date;
};

export type Candidate = Omit<CandidateInput, "priceCents" | "segment"> & {
  id: string;
  // A row v2 wrote may carry a product key instead of a segment; isKnownSegment tells them apart.
  segment: string;
  // NULL after 30 days (purge step 5).
  priceCents: number | null;
  // pending, alerted, blocked, rejected_after_enrich, gone or expired (the listing content aged out,
  // 6 h, before an alert could be made from it). A row v2 wrote may also hold wrong_product or held.
  decision: string;
  rejectReason: RejectReason | null;
  enrichStartedAt: Date | null;
  // Set by enrich from the getItem title and raw description; empty before.
  codeSignals: CodeSignal[];
};

const COLUMNS = `id, item_key, listing_id, feed_id, segment, source, price_cents, shipping_cents, landed_cents,
  shipping_known, total_gb, rule_version, flags, code_signals, decision, reject_reason, enrich_started_at, created_at`;

type CandidateRow = {
  id: string;
  item_key: string;
  listing_id: string;
  feed_id: FeedId;
  segment: string;
  source: "poll" | "sweep";
  price_cents: number | null;
  shipping_cents: number | null;
  landed_cents: number | null;
  shipping_known: boolean;
  total_gb: number | null;
  rule_version: number;
  flags: ListingFlag[];
  code_signals: CodeSignal[];
  decision: string;
  reject_reason: RejectReason | null;
  enrich_started_at: Date | null;
  created_at: Date;
};

const toCandidate = (row: CandidateRow): Candidate => ({
  id: row.id,
  itemKey: row.item_key,
  listingId: row.listing_id,
  feedId: row.feed_id,
  segment: row.segment,
  source: row.source,
  priceCents: row.price_cents,
  shippingCents: row.shipping_cents,
  landedCents: row.landed_cents,
  shippingKnown: row.shipping_known,
  totalGb: row.total_gb,
  ruleVersion: row.rule_version,
  flags: row.flags,
  decision: row.decision,
  rejectReason: row.reject_reason,
  enrichStartedAt: row.enrich_started_at,
  codeSignals: row.code_signals,
  createdAt: row.created_at,
});

// In the poll or sweep transaction, after claimCandidate returned true. item_key and listing_id are
// unique, so a second candidate for one item fails.
export async function insertCandidate(db: Queryable, input: CandidateInput): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO app.candidate
       (item_key, listing_id, feed_id, segment, source, price_cents, shipping_cents, landed_cents, shipping_known,
        total_gb, rule_version, flags, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      input.itemKey,
      input.listingId,
      input.feedId,
      input.segment,
      input.source,
      input.priceCents,
      input.shippingCents,
      input.landedCents,
      input.shippingKnown,
      input.totalGb,
      input.ruleVersion,
      input.flags,
      input.createdAt,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("candidate insert returned no row");
  return id;
}

export async function getCandidateByListingId(db: Queryable, listingId: string): Promise<Candidate | null> {
  const result = await db.query<CandidateRow>(`SELECT ${COLUMNS} FROM app.candidate WHERE listing_id = $1`, [listingId]);
  const row = result.rows[0];
  return row === undefined ? null : toCandidate(row);
}

// Set before the getItem call so relay can tell a lost enrich job from a running one. Only the
// first call wins (true): a duplicate enrich job never repeats a getItem that ran.
export async function markEnrichStarted(db: Queryable, candidateId: string, at: Date): Promise<boolean> {
  const result = await db.query(
    `UPDATE app.candidate SET enrich_started_at = $2
      WHERE id = $1 AND decision = 'pending' AND enrich_started_at IS NULL`,
    [candidateId, at],
  );
  return result.rowCount === 1;
}

export type EnrichedCandidate = {
  priceCents: number;
  shippingCents: number | null;
  landedCents: number | null;
  shippingKnown: boolean;
  flags: ListingFlag[];
  codeSignals: CodeSignal[];
};

// getItem's price and shipping options may change the price, make the shipping known (or keep it
// unknown) and add flags; the code scan of the raw description adds its signals.
export async function updateCandidateAfterEnrich(db: Queryable, candidateId: string, enriched: EnrichedCandidate): Promise<void> {
  await db.query(
    `UPDATE app.candidate SET price_cents = $2, shipping_cents = $3, landed_cents = $4, shipping_known = $5, flags = $6,
            code_signals = $7
      WHERE id = $1 AND decision = 'pending'`,
    [
      candidateId,
      enriched.priceCents,
      enriched.shippingCents,
      enriched.landedCents,
      enriched.shippingKnown,
      enriched.flags,
      enriched.codeSignals,
    ],
  );
}

export type DecisionInput =
  | { decision: "alerted" | "blocked" | "gone" | "expired"; rejectReason: null }
  | { decision: "expired"; rejectReason: "unknown_segment" }
  | { decision: "rejected_after_enrich"; rejectReason: RejectReason };

// The candidate's outcome, written once (true) in the transaction that makes it.
export async function setCandidateDecision(db: Queryable, candidateId: string, input: DecisionInput): Promise<boolean> {
  const result = await db.query(
    `UPDATE app.candidate SET decision = $2, reject_reason = $3
      WHERE id = $1 AND decision = 'pending'`,
    [candidateId, input.decision, input.rejectReason],
  );
  return result.rowCount === 1;
}

// Relay waits this long before it takes an enrich or screen job for lost (section 2.4).
export const RELAY_LOST_AFTER_MS = 10 * 60 * 1000;

// Relay: listing ids of pending candidates whose enrich never started 10 minutes after creation, or
// started 10 minutes ago and wrote no getItem content (the job died after the flag). Enrich
// finishes the second kind from the summary, without another getItem.
export async function listingsToEnrich(db: Queryable, now: Date, limit: number): Promise<string[]> {
  const result = await db.query<{ listing_id: string }>(
    `SELECT c.listing_id FROM app.candidate c
      WHERE c.decision = 'pending'
        AND ((c.enrich_started_at IS NULL AND c.created_at <= $1)
          OR (c.enrich_started_at <= $1 AND NOT EXISTS (
                SELECT 1 FROM ebay_live.listing_content lc WHERE lc.listing_id = c.listing_id AND lc.source = 'item')))
      ORDER BY c.created_at LIMIT $2`,
    [new Date(now.getTime() - RELAY_LOST_AFTER_MS), limit],
  );
  return result.rows.map((row) => row.listing_id);
}

// Pending candidates past the getItem step (or in it) with no screening at the prompt version yet:
// each will reserve a Claude call in its screen job, so the enrich slot check counts them as taken.
export async function countScreensInFlight(db: Queryable, promptVersion: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.candidate c
      WHERE c.decision = 'pending' AND c.enrich_started_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM app.screening s WHERE s.item_key = c.item_key AND s.prompt_version = $1)`,
    [promptVersion],
  );
  return result.rows[0]?.n ?? 0;
}

// Relay: listing ids of pending candidates with getItem content, enrich started 10 minutes ago or
// more, and no finished screening for the prompt version. The screen claim handles a running one.
export async function listingsToScreen(db: Queryable, promptVersion: string, now: Date, limit: number): Promise<string[]> {
  const result = await db.query<{ listing_id: string }>(
    `SELECT c.listing_id FROM app.candidate c
       JOIN ebay_live.listing_content lc ON lc.listing_id = c.listing_id AND lc.source = 'item'
      WHERE c.decision = 'pending' AND c.enrich_started_at <= $1
        AND NOT EXISTS (
          SELECT 1 FROM app.screening s
           WHERE s.item_key = c.item_key AND s.prompt_version = $2 AND s.status IN ('done', 'failed', 'skipped'))
      ORDER BY c.enrich_started_at LIMIT $3`,
    [new Date(now.getTime() - RELAY_LOST_AFTER_MS), promptVersion, limit],
  );
  return result.rows.map((row) => row.listing_id);
}

// Candidates of a segment created at or after `since` (the Berlin day's start), for the cap.
export async function countCandidatesSince(db: Queryable, segment: Segment, since: Date): Promise<number> {
  const result = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app.candidate WHERE segment = $1 AND created_at >= $2",
    [segment, since],
  );
  return result.rows[0]?.n ?? 0;
}
