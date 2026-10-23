import type { PriceSampleInput } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

// Section 3.5: one row per qualifying listing at its first poll sighting. No item key, ID, title
// or seller. v2 writes the product key into segment and, into feed_id, the search id (poll) or the
// product key (sweep); rows written before v2 hold a segment and a feed id.
export type PriceSampleRow = {
  segment: string;
  feedId: string;
  priceCents: number;
  shippingCents: number | null;
  // NULL when shipping is unknown.
  landedCents: number | null;
  totalGb: number | null;
  seenAt: Date;
};

export async function insertPriceSamples(db: Queryable, rows: readonly PriceSampleRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO app.price_sample (segment, feed_id, price_cents, shipping_cents, landed_cents, total_gb, seen_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::integer[], $4::integer[], $5::integer[], $6::integer[], $7::timestamptz[])`,
    [
      rows.map((r) => r.segment),
      rows.map((r) => r.feedId),
      rows.map((r) => r.priceCents),
      rows.map((r) => r.shippingCents),
      rows.map((r) => r.landedCents),
      rows.map((r) => r.totalGb),
      rows.map((r) => r.seenAt),
    ],
  );
}

// v2 writes feed_id and segment as for price_sample, and the matcher's reason.
export type ClassifierSampleRow = {
  feedId: string;
  segment: string | null;
  title: string;
  landedCents: number | null;
  outcome: "candidate" | "rejected";
  reason: string | null;
  seenAt: Date;
};

export const REJECTED_SAMPLES_PER_FEED_HOUR = 20;
const SAMPLE_LIFETIME = "6 hours";

// Section 4, rejected-title sample: every accepted title, and per feed and UTC hour the first 20
// rejected ones (rows already stored that hour count). Rows live 6 hours.
export async function insertClassifierSamples(db: Queryable, rows: readonly ClassifierSampleRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `WITH input AS (
       SELECT f, sg, ti, lc, o, r, t, ord, date_trunc('hour', t, 'UTC') AS h
         FROM unnest($1::text[], $2::text[], $3::text[], $4::integer[], $5::text[], $6::text[], $7::timestamptz[])
              WITH ORDINALITY AS u(f, sg, ti, lc, o, r, t, ord)
     ),
     rejected AS (
       SELECT i.*,
              row_number() OVER (PARTITION BY i.f, i.h ORDER BY i.ord) AS rn,
              (SELECT count(*) FROM ebay_live.classifier_sample c
                WHERE c.feed_id = i.f AND c.outcome = 'rejected'
                  AND c.seen_at >= i.h AND c.seen_at < i.h + interval '1 hour') AS stored
         FROM input i WHERE i.o = 'rejected'
     )
     INSERT INTO ebay_live.classifier_sample (feed_id, segment, title, landed_cents, outcome, reason, seen_at, expires_at)
     SELECT f, sg, ti, lc, o, r, t, t + $8::interval FROM input WHERE o = 'candidate'
     UNION ALL
     SELECT f, sg, ti, lc, o, r, t, t + $8::interval FROM rejected WHERE rn + stored <= $9`,
    [
      rows.map((r) => r.feedId),
      rows.map((r) => r.segment),
      rows.map((r) => r.title),
      rows.map((r) => r.landedCents),
      rows.map((r) => r.outcome),
      rows.map((r) => r.reason),
      rows.map((r) => r.seenAt),
      SAMPLE_LIFETIME,
      REJECTED_SAMPLES_PER_FEED_HOUR,
    ],
  );
}

// The samples of one segment seen at or after `since`, oldest first, for priceStatistics().
export async function priceSamplesSince(db: Queryable, segment: string, since: Date): Promise<PriceSampleInput[]> {
  const result = await db.query<{ landed_cents: number | null; total_gb: number | null }>(
    `SELECT landed_cents, total_gb FROM app.price_sample
      WHERE segment = $1 AND seen_at >= $2
      ORDER BY seen_at, id`,
    [segment, since],
  );
  return result.rows.map((row) => ({ landedCents: row.landed_cents, totalGb: row.total_gb }));
}
