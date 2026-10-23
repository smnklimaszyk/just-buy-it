import type { DbPool } from "@ebay-sniper/db";
import { QUEUES, type JobQueue } from "@ebay-sniper/db/queue";
import { inTransaction } from "../handlers/poll.js";

export type RequestQueueDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
};

// Spec 6.3, 6.6, 9: poll-tick's `queueRequests`. The web app only inserts market_request and
// category_request rows; this turns each open one into a job. The job is written in the
// transaction that marks the row queued, so a rollback leaves neither.
export function createRequestQueuer(deps: RequestQueueDeps): (now: Date) => Promise<void> {
  return async (now) => {
    await inTransaction(deps.pool, async (client) => {
      // A snapshot killed while running (out of memory, a host reboot) leaves its request
      // running, which the one-open-request index would keep forever. Without a run of the
      // product younger than the job's expiry, it is open again.
      await client.query(
        `UPDATE app.market_request AS r SET status = 'open'
          WHERE r.status = 'running'
            AND NOT EXISTS (SELECT 1 FROM app.market_run AS m WHERE m.product_id = r.product_id AND m.started_at > $1)`,
        [new Date(now.getTime() - QUEUES["market-snapshot"].expireInSeconds * 1000)],
      );
      const open = await client.query<{ id: string; product_id: string }>(
        `SELECT id, product_id FROM app.market_request WHERE status = 'open'
          ORDER BY requested_at, id FOR UPDATE SKIP LOCKED`,
      );
      for (const request of open.rows) {
        const job = await deps.queue.send("market-snapshot", { productId: request.product_id }, { db: client });
        if (job === null) continue;
        await client.query("UPDATE app.market_request SET status = 'queued' WHERE id = $1", [request.id]);
      }
      const categories = await client.query<{ id: string }>(
        "SELECT id FROM app.category_request WHERE status = 'open' ORDER BY created_at, id FOR UPDATE SKIP LOCKED",
      );
      for (const request of categories.rows) {
        const job = await deps.queue.send("category-suggest", { requestId: request.id }, { db: client });
        if (job === null) continue;
        await client.query("UPDATE app.category_request SET status = 'queued' WHERE id = $1", [request.id]);
      }
    });
  };
}
