import type { Clock } from "@ebay-sniper/domain";
import type { Queryable } from "./pool.js";

// Section 7.3: the purge (every 15 min), run by the worker as role worker. It touches only the
// worker's own tables and the ebay_live content. Every statement is its own transaction and
// changes at most batchSize rows, so each stays well under the 10 s statement timeout.

export const PURGE_BATCH_SIZE = 5_000;

export type PurgeCounts = Record<string, number>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// ADR 0014 rule 5: a listing not confirmed for 48 h is taken as gone.
export const UNCONFIRMED_AFTER_MS = 48 * HOUR_MS;

// Repeats the statement until it changes fewer rows than a full batch. The statement selects at
// most $1 rows by ctid; its condition must stop matching a row once the statement changed it.
async function batched(db: Queryable, statement: string, params: unknown[], batchSize: number): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.query(statement, [batchSize, ...params]);
    const changed = result.rowCount ?? 0;
    total += changed;
    if (changed < batchSize) return total;
  }
}

const deleteWhere = (table: string, condition: string) =>
  `DELETE FROM ${table} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${table} WHERE ${condition} LIMIT $1))`;

const updateWhere = (table: string, set: string, condition: string) =>
  `UPDATE ${table} SET ${set} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${table} WHERE ${condition} LIMIT $1))`;

export async function runPurge(db: Queryable, clock: Clock, options: { batchSize?: number } = {}): Promise<PurgeCounts> {
  const batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
  const startedAt = clock.now();
  const now = startedAt;
  const before = (ms: number) => new Date(now.getTime() - ms);
  const counts: PurgeCounts = {};
  const step = async (name: string, statement: string, params: unknown[]) => {
    counts[name] = await batched(db, statement, params, batchSize);
  };

  try {
    // 1. Content at its expiry.
    await step("listing_content", deleteWhere("ebay_live.listing_content", "content_expires_at <= $2"), [now]);
    await step("classifier_sample", deleteWhere("ebay_live.classifier_sample", "expires_at <= $2"), [now]);
    await step("screening_text", deleteWhere("ebay_live.screening_text", "expires_at <= $2"), [now]);
    await step("alert_message", deleteWhere("ebay_live.alert_message", "expires_at <= $2"), [now]);

    // 2. Listings that ended, or were not confirmed for 48 h, are gone.
    await step(
      "listing_ended",
      updateWhere("ebay_live.listing", "gone_at = $2, gone_reason = 'ended', updated_at = $2", "gone_at IS NULL AND item_end_at <= $2"),
      [now],
    );
    await step(
      "listing_unconfirmed",
      updateWhere(
        "ebay_live.listing",
        "gone_at = $2, gone_reason = 'unconfirmed', updated_at = $2",
        "gone_at IS NULL AND last_confirmed_at <= $3",
      ),
      [now, before(UNCONFIRMED_AFTER_MS)],
    );

    // 3. Gone listings, with their content (cascade).
    await step("listing", deleteWhere("ebay_live.listing", "gone_at IS NOT NULL"), []);

    // 4. A pending delivery whose message is gone is never sent.
    await step(
      "delivery_expired",
      updateWhere(
        "app.alert_delivery",
        "status = 'expired', updated_at = $2",
        "status = 'pending' AND NOT EXISTS (SELECT 1 FROM ebay_live.alert_message m WHERE m.delivery_id = alert_delivery.id)",
      ),
      [now],
    );

    // 5. Prices of candidates and alerts after 30 days.
    const pricesSet = "price_cents = NULL, shipping_cents = NULL, landed_cents = NULL";
    const hasPrices = "created_at <= $2 AND (price_cents IS NOT NULL OR shipping_cents IS NOT NULL OR landed_cents IS NOT NULL)";
    await step("candidate_prices", updateWhere("app.candidate", pricesSet, hasPrices), [before(30 * DAY_MS)]);
    await step("alert_prices", updateWhere("app.alert", pricesSet, hasPrices), [before(30 * DAY_MS)]);

    // 6. Rows past their lifetime.
    await step("seen_item", deleteWhere("app.seen_item", "last_seen_at <= $2"), [before(90 * DAY_MS)]);
    await step("price_sample", deleteWhere("app.price_sample", "seen_at <= $2"), [before(30 * DAY_MS)]);
    // A running row this old is long stale; the purge deletes it, it never rewrites it.
    await step("poll_run", deleteWhere("app.poll_run", "started_at <= $2"), [before(30 * DAY_MS)]);
    await step("purge_run", deleteWhere("app.purge_run", "started_at <= $2"), [before(30 * DAY_MS)]);
    for (const table of ["candidate", "screening", "alert", "alert_delivery"]) {
      await step(table, deleteWhere(`app.${table}`, "created_at <= $2"), [before(180 * DAY_MS)]);
    }
    await step(
      "llm_usage_daily",
      deleteWhere("app.llm_usage_daily", "day_berlin < (($2::timestamptz AT TIME ZONE 'Europe/Berlin') - interval '1 year')::date"),
      [now],
    );
  } catch (error) {
    // The run is recorded with the counts so far; the error that broke it is the one thrown.
    await writePurgeRun(db, startedAt, clock.now(), "error", counts).catch(() => undefined);
    throw error;
  }

  // 7. The run with its counts (numbers only).
  await writePurgeRun(db, startedAt, clock.now(), "ok", counts);
  return counts;
}

async function writePurgeRun(
  db: Queryable,
  startedAt: Date,
  finishedAt: Date,
  status: "ok" | "error",
  counts: PurgeCounts,
): Promise<void> {
  await db.query("INSERT INTO app.purge_run (started_at, finished_at, status, counts) VALUES ($1, $2, $3, $4)", [
    startedAt,
    finishedAt,
    status,
    counts,
  ]);
}
