import {
  deliveriesDue,
  failLostDeliveries,
  listingsToEnrich,
  listingsToScreen,
  MAX_DELIVERY_ATTEMPTS,
  type DbPool,
} from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import type { Clock } from "@ebay-sniper/domain";
import { PROMPT_VERSION } from "@ebay-sniper/llm";
import type { LogFn } from "./poll.js";

export type RelayDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  log: { info: LogFn; warn: LogFn };
};

// Rows taken per kind and run; the rest follow a minute later.
const RELAY_BATCH = 100;

// Section 2.4, every minute: the one retry path for send. The send queue is exclusive per
// delivery, so a delivery whose job is still queued gets no second one.
export function createRelayHandler(deps: RelayDeps): JobHandler<"relay"> {
  return async () => {
    const now = deps.clock.now();
    // A sending row past its lease on the fifth attempt can never be claimed again, so it fails
    // with lease_lost.
    for (const deliveryId of await failLostDeliveries(deps.pool, now)) {
      deps.log.warn({
        event: "delivery",
        delivery_id: deliveryId,
        status: "failed",
        hold_reason: null,
        attempt: MAX_DELIVERY_ATTEMPTS,
        smtp_code: null,
        error: "lease_lost",
      });
    }
    for (const deliveryId of await deliveriesDue(deps.pool, now, RELAY_BATCH)) {
      await deps.queue.send("send", { deliveryId });
    }
    // The crash path for screen: a candidate with getItem content and no finished screening 10
    // minutes after enrich started lost its screen job.
    for (const listingId of await listingsToScreen(deps.pool, PROMPT_VERSION, now, RELAY_BATCH)) {
      await deps.queue.send("screen", { listingId });
    }
    // The crash path for enrich: a pending candidate whose enrich never started 10 minutes after
    // it was made lost its enrich job.
    for (const listingId of await listingsToEnrich(deps.pool, now, RELAY_BATCH)) {
      await deps.queue.send("enrich", { listingId });
    }
  };
}
