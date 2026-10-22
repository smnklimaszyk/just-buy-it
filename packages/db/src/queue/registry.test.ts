import { describe, expect, it } from "vitest";
import { pgBossQueues, QUEUE_NAMES, QUEUES, QueuePayloadError, WORKER_POOL_MAX } from "./registry.js";

describe("queue registry (section 2.3)", () => {
  it("holds the policy, schedule, deadline, expiry, retries and concurrency of the handler table", () => {
    const table = QUEUE_NAMES.map((name) => {
      const q = QUEUES[name];
      return [name, q.policy, q.cron, q.deadlineMs, q.expireInSeconds, q.retryLimit, q.retryDelaySeconds, q.localConcurrency];
    });

    expect(table).toEqual([
      ["poll-tick", "exclusive", "* * * * *", 10_000, 60, 0, 0, 1],
      ["poll", "exclusive", null, 100_000, 150, 0, 0, 1],
      ["sweep", "exclusive", null, 40_000, 90, 0, 0, 1],
      ["enrich", "standard", null, 40_000, 90, 0, 0, 2],
      ["screen", "standard", null, 75_000, 180, 1, 30, 1],
      ["send", "exclusive", null, 40_000, 90, 0, 0, 1],
      ["relay", "exclusive", "* * * * *", 20_000, 60, 0, 0, 1],
      ["purge", "exclusive", "*/15 * * * *", 120_000, 600, 0, 0, 1],
    ]);
  });

  it("expires a job only after its handler deadline has passed", () => {
    for (const name of QUEUE_NAMES) {
      expect(QUEUES[name].expireInSeconds * 1000, name).toBeGreaterThan(QUEUES[name].deadlineMs);
    }
  });

  it("keys the exclusive queues on feedId, segment and deliveryId", () => {
    expect(QUEUES.poll.singletonKey({ feedId: "ram" })).toBe("ram");
    expect(QUEUES.sweep.singletonKey({ segment: "gpu_4090" })).toBe("gpu_4090");
    expect(QUEUES.send.singletonKey({ deliveryId: LISTING_ID })).toBe(LISTING_ID);
    expect(QUEUES["poll-tick"].singletonKey({})).toBeNull();
    expect(QUEUES.enrich.singletonKey({ listingId: LISTING_ID })).toBeNull();
  });

  it("sizes the worker pool at the summed handler concurrency plus one (section 2.5)", () => {
    expect(WORKER_POOL_MAX).toBe(10);
  });
});

describe("pgBossQueues", () => {
  it("creates each dead letter queue before the queue that names it, all with the shared retention", () => {
    const queues = pgBossQueues();

    expect(queues.map((queue) => queue.name)).toEqual(QUEUE_NAMES.flatMap((name) => [`${name}.dead`, name]));
    expect(new Map(queues.map((queue) => [queue.name, queue.options])).get("screen")).toEqual({
      policy: "standard",
      expireInSeconds: 180,
      retentionSeconds: 21_600,
      deleteAfterSeconds: 3_600,
      retryLimit: 1,
      retryDelay: 30,
      deadLetter: "screen.dead",
    });
    expect(new Map(queues.map((queue) => [queue.name, queue.options])).get("screen.dead")).toEqual({
      policy: "standard",
      retentionSeconds: 21_600,
      deleteAfterSeconds: 3_600,
      retryLimit: 0,
    });
  });
});

const LISTING_ID = "0199f0a2-7c1e-7b3a-9d4e-2f6a8b0c1d2e";

describe("payloads", () => {
  it("accept the surrogate keys of each queue", () => {
    expect(QUEUES["poll-tick"].parse({})).toEqual({});
    expect(QUEUES.poll.parse({ feedId: "gpu" })).toEqual({ feedId: "gpu" });
    expect(QUEUES.sweep.parse({ segment: "ram_ddr5" })).toEqual({ segment: "ram_ddr5" });
    expect(QUEUES.enrich.parse({ listingId: LISTING_ID })).toEqual({ listingId: LISTING_ID });
    expect(QUEUES.screen.parse({ listingId: LISTING_ID })).toEqual({ listingId: LISTING_ID });
    expect(QUEUES.send.parse({ deliveryId: LISTING_ID })).toEqual({ deliveryId: LISTING_ID });
    expect(QUEUES.relay.parse({})).toEqual({});
    expect(QUEUES.purge.parse({})).toEqual({});
  });

  it.each([
    ["poll", { feedId: "gpu", itemId: "v1|123456789012|0" }],
    ["poll", { feedId: "tv" }],
    ["poll", {}],
    ["sweep", { segment: "gpu_5090" }],
    ["enrich", { listingId: "v1|123456789012|0" }],
    ["enrich", { listingId: LISTING_ID, title: "RTX 3090" }],
    ["screen", { listingId: LISTING_ID.toUpperCase() }],
    ["send", { deliveryId: 42 }],
    ["relay", { url: "https://www.ebay.de/itm/123" }],
    ["purge", null],
    ["poll-tick", []],
  ] as const)("refuse a %s payload %j and name only the queue and field", (name, data) => {
    let caught: unknown;
    try {
      QUEUES[name].parse(data);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QueuePayloadError);
    const message = (caught as Error).message;
    expect(message.startsWith(`${name} payload: `)).toBe(true);
    for (const value of ["v1|", "tv", "gpu_5090", "RTX", LISTING_ID.toUpperCase(), "42", "ebay.de"]) {
      expect(message).not.toContain(value);
    }
  });
});
