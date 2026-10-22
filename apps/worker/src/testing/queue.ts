import { startQueue, type JobQueue, type QueueName } from "@ebay-sniper/db/queue";
import type { TestDatabase } from "./database.js";

// pg-boss on the test database as role worker, the queue the handlers enqueue on.
export async function startTestQueue(db: TestDatabase): Promise<JobQueue> {
  return startQueue({
    connectionString: db.workerUrl,
    onError: (error) => {
      throw error;
    },
  });
}

// The payloads of a queue's jobs, oldest first.
export async function jobs(db: TestDatabase, name: QueueName): Promise<unknown[]> {
  const result = await db.admin.query<{ data: unknown }>(
    "SELECT data FROM pgboss.job WHERE name = $1 ORDER BY created_on, id",
    [name],
  );
  return result.rows.map((row) => row.data);
}

const DATA_TABLES = [
  "ebay_live.listing",
  "ebay_live.listing_content",
  "ebay_live.classifier_sample",
  "ebay_live.screening_text",
  "ebay_live.alert_message",
  "app.seen_item",
  "app.price_sample",
  "app.poll_run",
  "app.candidate",
  "app.screening",
  "app.screening_pause",
  "app.llm_usage_daily",
  "app.alert",
  "app.alert_delivery",
  "app.smtp_pause",
  "app.purge_run",
  "app.worker_status",
  "app.ebay_quota_window",
  "app.api_usage_hourly",
  "app.audit_event",
];

// Empties every table the worker writes and every queue, and puts the feeds and segment rules back
// to the seeded rows of migration 0006 (copied once per database on the first call).
export async function resetTables(db: TestDatabase): Promise<void> {
  await db.admin.query(`TRUNCATE ${DATA_TABLES.join(", ")}`);
  await db.admin.query("DELETE FROM pgboss.job");
  await db.admin.query("CREATE TABLE IF NOT EXISTS public.test_feed_seed AS SELECT * FROM app.feed");
  await db.admin.query("CREATE TABLE IF NOT EXISTS public.test_segment_rule_seed AS SELECT * FROM app.segment_rule");
  await db.admin.query("DELETE FROM app.segment_rule");
  await db.admin.query("DELETE FROM app.feed");
  await db.admin.query("INSERT INTO app.feed SELECT * FROM public.test_feed_seed");
  await db.admin.query("INSERT INTO app.segment_rule SELECT * FROM public.test_segment_rule_seed");
}
