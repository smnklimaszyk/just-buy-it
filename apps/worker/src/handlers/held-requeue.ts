import type { DbPool, Queryable } from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import { berlinWallTime, type Clock } from "@ebay-sniper/domain";
import { inTransaction, type LogFn } from "./poll.js";

export type HeldRequeueDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  log: { info: LogFn; warn: LogFn };
};

// The held reasons of the daily Claude caps (the screen reservation and the enrich slot check).
// They reset at Berlin midnight; every other held reason is final.
export const CAP_HELD_REASONS = ["cap_reached", "spend_cap_reached", "product_share_reached"] as const;

type HeldCandidate = {
  id: string;
  listingId: string;
  itemKey: string;
  promptVersion: string | null;
  // getItem content that has not expired: screen can run on it.
  hasItemContent: boolean;
};

// A deal first seen this long ago is stale by the time the caps reset.
export const REQUEUE_MAX_AGE_MS = 12 * 60 * 60_000;

// Cap-held candidates of a listing that is still live and was first seen under 12 hours ago.
async function capHeldCandidates(db: Queryable, now: Date): Promise<HeldCandidate[]> {
  const result = await db.query<{
    id: string;
    listing_id: string;
    item_key: string;
    prompt_version: string | null;
    has_item_content: boolean;
  }>(
    `SELECT c.id, c.listing_id, c.item_key, c.prompt_version,
            coalesce(lc.source = 'item' AND lc.content_expires_at > $2, false) AS has_item_content
       FROM app.candidate c
       JOIN ebay_live.listing l ON l.id = c.listing_id
       LEFT JOIN ebay_live.listing_content lc ON lc.listing_id = c.listing_id
      WHERE c.decision = 'held' AND c.held_reason = ANY ($1::text[])
        AND l.gone_at IS NULL AND (l.item_end_at IS NULL OR l.item_end_at > $2) AND l.first_seen_at > $3
      ORDER BY c.created_at, c.id`,
    [CAP_HELD_REASONS, now, new Date(now.getTime() - REQUEUE_MAX_AGE_MS)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    listingId: row.listing_id,
    itemKey: row.item_key,
    promptVersion: row.prompt_version,
    hasItemContent: row.has_item_content,
  }));
}

// The candidate is pending again, and the claim its screen skipped is cleared, so the next screen
// claims afresh at the prompt version enrich fixed. Without getItem content enrich starts over
// (it runs getItem only while enrich_started_at is unset). False when another run took it first.
async function reopen(db: Queryable, candidate: HeldCandidate): Promise<boolean> {
  const reopened = await db.query(
    `UPDATE app.candidate
        SET decision = 'pending', held_reason = NULL, enrich_started_at = CASE WHEN $2 THEN enrich_started_at END
      WHERE id = $1 AND decision = 'held'`,
    [candidate.id, candidate.hasItemContent],
  );
  if (reopened.rowCount !== 1) return false;
  await db.query("DELETE FROM app.screening WHERE item_key = $1 AND prompt_version = $2 AND status = 'skipped'", [
    candidate.itemKey,
    candidate.promptVersion,
  ]);
  return true;
}

// Spec 4.3: a candidate held because a daily cap was reached goes back on the screen queue at
// 00:05 Berlin. The registry's cron is in UTC, so it fires at 22:05 and at 23:05 UTC, and only
// the run in the Berlin hour after midnight (CEST or CET) acts.
export function createHeldRequeueHandler(deps: HeldRequeueDeps): JobHandler<"held-requeue"> {
  return async () => {
    const now = deps.clock.now();
    if (berlinWallTime(now).hour !== 0) return;
    const queued = { screen: 0, enrich: 0 };
    for (const candidate of await capHeldCandidates(deps.pool, now)) {
      const target = candidate.hasItemContent ? "screen" : "enrich";
      const reopened = await inTransaction(deps.pool, async (client) => {
        if (!(await reopen(client, candidate))) return false;
        // On the transaction's client: a rollback leaves no job.
        await deps.queue.send(target, { listingId: candidate.listingId }, { db: client });
        return true;
      });
      if (reopened) queued[target] += 1;
    }
    deps.log.info({ event: "held_requeue", ...queued });
  };
}
