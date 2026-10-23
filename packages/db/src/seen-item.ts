import type { Queryable } from "./pool.js";

// v2 writes the search id (poll) or the product key (sweep) into feed_id and the matched
// product's key, or NULL, into segment. Rows written before v2 hold a feed id, a segment and
// outcomes v2 does not know, so all three read as plain codes.
export type SeenItemSighting = {
  itemKey: string;
  keyVersion: number;
  feedId: string;
  segment: string | null;
  outcome: string;
  seenAt: Date;
};

export type SeenItemState = {
  feedId: string;
  segment: string | null;
  outcome: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  candidateAt: Date | null;
};

// The seen_item rows of the given keys, in the order of the keys. A key without a row is a first
// sighting and is missing from the map.
export async function getSeenItems(db: Queryable, itemKeys: readonly string[]): Promise<Map<string, SeenItemState>> {
  const result = await db.query<{
    item_key: string;
    feed_id: string;
    segment: string | null;
    outcome: string;
    first_seen_at: Date;
    last_seen_at: Date;
    candidate_at: Date | null;
  }>(
    `SELECT item_key, feed_id, segment, outcome, first_seen_at, last_seen_at, candidate_at
       FROM app.seen_item WHERE item_key = ANY($1)`,
    [itemKeys],
  );
  const byKey = new Map(result.rows.map((row) => [row.item_key, row]));
  const states = new Map<string, SeenItemState>();
  for (const itemKey of itemKeys) {
    const row = byKey.get(itemKey);
    if (row === undefined || states.has(itemKey)) continue;
    states.set(itemKey, {
      feedId: row.feed_id,
      segment: row.segment,
      outcome: row.outcome,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      candidateAt: row.candidate_at,
    });
  }
  return states;
}

// Section 2.4, candidate once: true for the one caller that turns the item into a candidate. Run it
// in the poll or sweep transaction after upsertSeenItems; only a true result inserts the listing,
// the candidate and the enrich job.
export async function claimCandidate(db: Queryable, itemKey: string, at: Date): Promise<boolean> {
  const result = await db.query(
    `UPDATE app.seen_item SET candidate_at = $2, outcome = 'candidate'
      WHERE item_key = $1 AND candidate_at IS NULL
      RETURNING item_key`,
    [itemKey, at],
  );
  return result.rowCount === 1;
}

// One statement for a page of sightings. A later sighting moves last_seen_at and the outcome; an
// item that already became a candidate keeps the outcome `candidate` (one alert per item, Q6).
// Only claimCandidate sets candidate_at.
export async function upsertSeenItems(db: Queryable, sightings: readonly SeenItemSighting[]): Promise<void> {
  // ON CONFLICT DO UPDATE cannot change one row twice in a statement: the last sighting of a key wins.
  const unique = [...new Map(sightings.map((s) => [s.itemKey, s])).values()];
  if (unique.length === 0) return;
  await db.query(
    `INSERT INTO app.seen_item AS s (item_key, key_version, feed_id, segment, outcome, first_seen_at, last_seen_at)
     SELECT k, v, f, sg, o, t, t
       FROM unnest($1::text[], $2::smallint[], $3::text[], $4::text[], $5::text[], $6::timestamptz[]) AS u(k, v, f, sg, o, t)
     ON CONFLICT (item_key) DO UPDATE
       SET last_seen_at = greatest(s.last_seen_at, EXCLUDED.last_seen_at),
           segment = coalesce(EXCLUDED.segment, s.segment),
           outcome = CASE WHEN s.candidate_at IS NULL THEN EXCLUDED.outcome ELSE s.outcome END`,
    [
      unique.map((s) => s.itemKey),
      unique.map((s) => s.keyVersion),
      unique.map((s) => s.feedId),
      unique.map((s) => s.segment),
      unique.map((s) => s.outcome),
      unique.map((s) => s.seenAt),
    ],
  );
}
