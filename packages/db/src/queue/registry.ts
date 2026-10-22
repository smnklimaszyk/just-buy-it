import { FEED_IDS, SEGMENTS, type FeedId, type Segment } from "@ebay-sniper/domain";
import type { Queue } from "pg-boss";

// The only list of queues (section 2.3). Handlers, schedules and the migrate step read it from here.

export const QUEUE_NAMES = ["poll-tick", "poll", "sweep", "enrich", "screen", "send", "relay", "purge"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

type Empty = Record<string, never>;

// Surrogate keys only (ADR 0015 A): never an item ID, title or URL.
export type QueuePayloads = {
  "poll-tick": Empty;
  poll: { feedId: FeedId };
  sweep: { segment: Segment };
  enrich: { listingId: string };
  screen: { listingId: string };
  send: { deliveryId: string };
  relay: Empty;
  purge: Empty;
};

export class QueuePayloadError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The message names the queue and the field, never a value: a wrong payload may carry listing data.
function fields(queue: QueueName, data: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new QueuePayloadError(`${queue} payload: not an object`);
  }
  if (Object.keys(data).some((key) => !allowed.includes(key))) {
    throw new QueuePayloadError(`${queue} payload: unknown field`);
  }
  return { ...data };
}

function invalid(queue: QueueName, field: string): QueuePayloadError {
  return new QueuePayloadError(`${queue} payload: invalid field ${field}`);
}

function empty(queue: QueueName): (data: unknown) => Empty {
  return (data) => {
    fields(queue, data, []);
    return {};
  };
}

function uuidField(queue: QueueName, data: unknown, field: string): string {
  const value = fields(queue, data, [field])[field];
  if (typeof value !== "string" || !UUID.test(value)) throw invalid(queue, field);
  return value;
}

function parseFeedId(data: unknown): { feedId: FeedId } {
  const value = fields("poll", data, ["feedId"]).feedId;
  const feedId = FEED_IDS.find((id) => id === value);
  if (feedId === undefined) throw invalid("poll", "feedId");
  return { feedId };
}

function parseSegment(data: unknown): { segment: Segment } {
  const value = fields("sweep", data, ["segment"]).segment;
  const segment = SEGMENTS.find((s) => s === value);
  if (segment === undefined) throw invalid("sweep", "segment");
  return { segment };
}

export type QueueDefinition<N extends QueueName> = {
  name: N;
  parse: (data: unknown) => QueuePayloads[N];
  // With the exclusive policy: one job per key queued or active. Null is one job for the queue.
  singletonKey: (payload: QueuePayloads[N]) => string | null;
  policy: "standard" | "exclusive";
  // Cron expression in UTC for the scheduled queues.
  cron: string | null;
  // The handler's AbortSignal fires after this; expireInSeconds is always longer.
  deadlineMs: number;
  expireInSeconds: number;
  retryLimit: number;
  retryDelaySeconds: number;
  localConcurrency: number;
};

export const QUEUES: { [N in QueueName]: QueueDefinition<N> } = {
  "poll-tick": {
    name: "poll-tick",
    parse: empty("poll-tick"),
    singletonKey: () => null,
    policy: "exclusive",
    cron: "* * * * *",
    deadlineMs: 10_000,
    expireInSeconds: 60,
    retryLimit: 0,
    retryDelaySeconds: 0,
    localConcurrency: 1,
  },
  // Up to 3 pages, each up to 3 attempts of 10 s. The next tick is the retry.
  poll: {
    name: "poll",
    parse: parseFeedId,
    singletonKey: (payload) => payload.feedId,
    policy: "exclusive",
    cron: null,
    deadlineMs: 100_000,
    expireInSeconds: 150,
    retryLimit: 0,
    retryDelaySeconds: 0,
    localConcurrency: 1,
  },
  sweep: {
    name: "sweep",
    parse: parseSegment,
    singletonKey: (payload) => payload.segment,
    policy: "exclusive",
    cron: null,
    deadlineMs: 40_000,
    expireInSeconds: 90,
    retryLimit: 0,
    retryDelaySeconds: 0,
    localConcurrency: 1,
  },
  enrich: {
    name: "enrich",
    parse: (data) => ({ listingId: uuidField("enrich", data, "listingId") }),
    singletonKey: () => null,
    policy: "standard",
    cron: null,
    deadlineMs: 40_000,
    expireInSeconds: 90,
    retryLimit: 0,
    retryDelaySeconds: 0,
    localConcurrency: 2,
  },
  // A 60 s Claude timeout inside a 75 s deadline. One retry 30 s later takes over the released lease.
  screen: {
    name: "screen",
    parse: (data) => ({ listingId: uuidField("screen", data, "listingId") }),
    singletonKey: () => null,
    policy: "standard",
    cron: null,
    deadlineMs: 75_000,
    expireInSeconds: 180,
    retryLimit: 1,
    retryDelaySeconds: 30,
    localConcurrency: 1,
  },
  // Relay is the one retry path for send.
  send: {
    name: "send",
    parse: (data) => ({ deliveryId: uuidField("send", data, "deliveryId") }),
    singletonKey: (payload) => payload.deliveryId,
    policy: "exclusive",
    cron: null,
    deadlineMs: 40_000,
    expireInSeconds: 90,
    retryLimit: 0,
    retryDelaySeconds: 0,
    localConcurrency: 1,
  },
  relay: {
    name: "relay",
    parse: empty("relay"),
    singletonKey: () => null,
    policy: "exclusive",
    cron: "* * * * *",
    deadlineMs: 20_000,
    expireInSeconds: 60,
    retryLimit: 0,
    retryDelaySeconds: 0,
    localConcurrency: 1,
  },
  // Batched statements of at most 5,000 rows.
  purge: {
    name: "purge",
    parse: empty("purge"),
    singletonKey: () => null,
    policy: "exclusive",
    cron: "*/15 * * * *",
    deadlineMs: 120_000,
    expireInSeconds: 600,
    retryLimit: 0,
    retryDelaySeconds: 0,
    localConcurrency: 1,
  },
};

// Every handler holds a client (never across an eBay, Claude or SMTP call), so the worker pool is
// the summed concurrency plus one for the heartbeat and the worker_status write (ADR 0015).
export const WORKER_POOL_MAX = QUEUE_NAMES.reduce((sum, name) => sum + QUEUES[name].localConcurrency, 0) + 1;

// Jobs not run within 6 h are deleted; finished jobs are kept 1 h.
export const QUEUE_RETENTION_SECONDS = 21_600;
export const QUEUE_DELETE_AFTER_SECONDS = 3_600;

export function deadLetterName(name: QueueName): string {
  return `${name}.dead`;
}

// The queues as the migrate step creates them, each dead letter queue before the queue naming it.
// Nothing works the dead letter queues; their jobs leave with the shared retention.
export function pgBossQueues(): { name: string; options: Omit<Queue, "name"> }[] {
  const shared = { retentionSeconds: QUEUE_RETENTION_SECONDS, deleteAfterSeconds: QUEUE_DELETE_AFTER_SECONDS };
  return QUEUE_NAMES.flatMap((name) => {
    const queue = QUEUES[name];
    return [
      { name: deadLetterName(name), options: { policy: "standard", ...shared, retryLimit: 0 } },
      {
        name,
        options: {
          policy: queue.policy,
          expireInSeconds: queue.expireInSeconds,
          ...shared,
          retryLimit: queue.retryLimit,
          retryDelay: queue.retryDelaySeconds,
          deadLetter: deadLetterName(name),
        },
      },
    ];
  });
}
