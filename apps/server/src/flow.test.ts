import { randomUUID } from "node:crypto";
import { addHourlyCounts, createPool, recordDeletionEvent } from "@ebay-sniper/db";
import type { FetchFn } from "@ebay-sniper/ebay";
import { describe, expect, it, vi } from "vitest";
import { createApp, type IncomingNotification } from "./app.js";
import { createDeletionCounters, type HourlyCounts } from "./deletion-counters.js";
import { createDeletionQueue } from "./deletion-queue.js";
import { createKeyLookup } from "./ebay-wiring.js";
import { createNotificationWork, type VerifiedEvent } from "./notifications.js";
import { createShutdown, SHUTDOWN_TIMING } from "./shutdown.js";
import { createSigner, notificationBody, USER_SENTINELS } from "./testing/signed.js";

// The server's pieces wired as main.ts wires them, with eBay and the database replaced by fakes
// that have the same signatures and the same upsert semantics.

const apiBase = "https://api.ebay.test";
const credentials = { clientId: "app-id", clientSecret: "cert-id" };
const T0 = Date.parse("2026-10-20T10:00:00Z");

type FlowOptions = {
  fetchFn?: FetchFn;
  credentials?: { clientId: string; clientSecret: string } | undefined;
  recordVerified?: (event: VerifiedEvent) => Promise<"inserted" | "updated">;
  store?: (counts: HourlyCounts) => Promise<void>;
};

// Never answers on its own; rejects when the request signal aborts, like the real fetch.
const hangingFetch: FetchFn = (_url, init) =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

// eBay: the token endpoint always answers; the key endpoint answers with the given function.
function ebay(answerKey: (kid: string, init: RequestInit | undefined) => Promise<Response>): FetchFn {
  return async (url, init) => {
    const href = String(url);
    if (href === `${apiBase}/identity/v1/oauth2/token`) return Response.json({ access_token: "app-token", expires_in: 7200 });
    return answerKey(decodeURIComponent(href.split("/public_key/")[1] ?? ""), init);
  };
}

function createFlow(options: FlowOptions = {}) {
  let nowMs = T0;
  const clock = { now: () => new Date(nowMs) };
  const lines: Record<string, unknown>[] = [];
  const events: string[] = [];
  const log = {
    info: (entry: Record<string, unknown>) => {
      lines.push(entry);
      events.push(`log ${String(entry.event)}`);
    },
    warn: (entry: Record<string, unknown>) => {
      lines.push(entry);
      events.push(`log ${String(entry.event)}`);
    },
  };
  const rows = new Map<string, VerifiedEvent>();
  const recordVerified = vi.fn(
    options.recordVerified ??
      (async (event: VerifiedEvent) => {
        events.push(`recordVerified ${event.notificationId}`);
        const existing = rows.get(event.notificationId);
        if (!existing) {
          rows.set(event.notificationId, event);
          return "inserted" as const;
        }
        existing.publishAttemptCount = Math.max(existing.publishAttemptCount, event.publishAttemptCount);
        return "updated" as const;
      }),
  );
  const stored: HourlyCounts[] = [];
  const counters = createDeletionCounters({
    clock,
    store:
      options.store ??
      (async (counts) => {
        events.push("store");
        stored.push(counts);
      }),
    log,
  });
  const fetchFn = vi.fn<FetchFn>(options.fetchFn ?? hangingFetch);
  const lookupKey = createKeyLookup({
    apiBase,
    credentials: "credentials" in options ? options.credentials : credentials,
    fetchFn,
    clock,
    countRequest: counters.countRequest,
  });
  const queue = createDeletionQueue<IncomingNotification>({
    capacity: 1_000,
    concurrency: 4,
    work: createNotificationWork({ lookupKey, countResult: counters.countResult, recordVerified, log, clock }),
    onDropped: counters.countResult,
    onError: () => lines.push({ event: "ebay_account_deletion", msg: "notification processing failed" }),
  });
  const app = createApp({
    endpointUrl: "https://deals.intra-ai.de/ebay/account-deletion",
    verificationToken: "t".repeat(64),
    gitSha: "0123456789abcdef0123456789abcdef01234567",
    probeCode: "p".repeat(40),
    onProbe: () => undefined,
    onNotification: queue.push,
  });

  async function post(notification: IncomingNotification): Promise<number> {
    const res = await app.request("/ebay/account-deletion", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ebay-signature": notification.signatureHeader ?? "" },
      body: notification.rawBody,
    });
    return res.status;
  }

  async function idle(): Promise<void> {
    do await new Promise((resolve) => setImmediate(resolve));
    while (queue.pending + queue.running > 0);
  }

  // Every count written by the flushes so far, by result and by api_usage purpose.
  function totals() {
    const results: Record<string, number> = {};
    const usage: Record<string, number> = {};
    for (const counts of stored) {
      for (const row of counts.deletionResults) results[row.result] = (results[row.result] ?? 0) + row.count;
      for (const row of counts.apiUsage) usage[`${row.resource}/${row.purpose}`] = (usage[`${row.resource}/${row.purpose}`] ?? 0) + row.calls;
    }
    return { results, usage };
  }

  const keyCalls = () => fetchFn.mock.calls.filter(([url]) => String(url).includes("/public_key/")).length;
  const tokenCalls = () => fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/oauth2/token")).length;

  return {
    app,
    queue,
    counters,
    fetchFn,
    recordVerified,
    rows,
    lines,
    events,
    post,
    idle,
    totals,
    log,
    keyCalls,
    tokenCalls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("deletion flow", () => {
  it("returns 204 within 1 s before any eBay request, then starts the lookup (A2)", async () => {
    const flow = createFlow();
    const notification = createSigner().signed(notificationBody());

    const started = performance.now();
    const status = await flow.post(notification);
    const elapsedMs = performance.now() - started;

    expect(status).toBe(204);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(flow.fetchFn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(flow.fetchFn).toHaveBeenCalled());
    expect(String(flow.fetchFn.mock.calls[0]?.[0])).toBe(`${apiBase}/identity/v1/oauth2/token`);
    await flow.queue.drain(0);
  });

  it("returns 204 within 1 s without eBay credentials, makes no request and counts key_unavailable (A2)", async () => {
    const flow = createFlow({ credentials: undefined });
    const notification = createSigner().signed(notificationBody());

    const started = performance.now();
    const status = await flow.post(notification);
    const elapsedMs = performance.now() - started;

    expect(status).toBe(204);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(flow.lines).toEqual([]);
    await flow.idle();
    await flow.counters.flush();
    expect(flow.fetchFn).not.toHaveBeenCalled();
    expect(flow.totals().results).toEqual({ key_unavailable: 1 });
    expect(flow.lines).toEqual([
      {
        event: "ebay_account_deletion",
        result: "key_unavailable",
        notificationId: notificationBody().notification.notificationId,
        err_kind: "not_configured",
      },
    ]);
  });

  it("answers 204 with the database down and logs the verified event without user identifiers (A4)", async () => {
    const poolErrors: Error[] = [];
    const pool = createPool({
      connectionString: "postgres://app:x@127.0.0.1:1/x",
      max: 3,
      applicationName: "ebay-sniper-server-test",
      onError: (error) => poolErrors.push(error),
    });
    const signer = createSigner();
    const flow = createFlow({
      fetchFn: ebay(async () => Response.json({ key: signer.publicKey })),
      recordVerified: (event) => recordDeletionEvent(pool, event),
      store: (counts) => addHourlyCounts(pool, counts),
    });

    try {
      const signedStatus = await flow.post(signer.signed(notificationBody({ notificationId: "a4-signed" })));
      const malformedStatus = await flow.post({ rawBody: "{not json", signatureHeader: undefined });
      await flow.idle();
      await vi.waitFor(() =>
        expect(flow.lines.some((line) => line.event === "ebay_account_deletion_saved")).toBe(true),
      );
      await flow.counters.flush();

      expect([signedStatus, malformedStatus]).toEqual([204, 204]);
      expect(flow.lines).toContainEqual(
        expect.objectContaining({ event: "ebay_account_deletion", result: "verified", notificationId: "a4-signed" }),
      );
      expect(flow.lines).toContainEqual({
        event: "ebay_account_deletion_saved",
        notificationId: "a4-signed",
        saved: false,
        err_code: "ECONNREFUSED",
      });
      expect(flow.lines).toContainEqual(expect.objectContaining({ event: "deletion_counts_unsaved" }));
      const logged = JSON.stringify(flow.lines);
      for (const sentinel of USER_SENTINELS) expect(logged).not.toContain(sentinel);
    } finally {
      await pool.end();
    }
  });

  it("saves a signed notification once with the four audit fields, after its verified line (A5)", async () => {
    const signer = createSigner();
    const flow = createFlow({ fetchFn: ebay(async () => Response.json({ key: signer.publicKey })) });
    const body = notificationBody({ notificationId: "a5-signed", publishAttemptCount: 2 });

    expect(await flow.post(signer.signed(body))).toBe(204);
    await flow.idle();

    expect(flow.recordVerified.mock.calls).toEqual([
      [
        {
          notificationId: "a5-signed",
          topic: "MARKETPLACE_ACCOUNT_DELETION",
          eventDate: new Date(body.notification.eventDate),
          publishAttemptCount: 2,
        },
      ],
    ]);
    expect(flow.events).toEqual([
      "log ebay_account_deletion",
      "recordVerified a5-signed",
      "log ebay_account_deletion_saved",
    ]);
    expect(flow.lines[0]).toEqual({
      event: "ebay_account_deletion",
      result: "verified",
      notificationId: "a5-signed",
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      eventDate: body.notification.eventDate,
      publishAttemptCount: 2,
    });
  });

  it("counts a tampered body as bad_signature and saves nothing (A5)", async () => {
    const signer = createSigner();
    const flow = createFlow({ fetchFn: ebay(async () => Response.json({ key: signer.publicKey })) });
    const signed = signer.signed(notificationBody());
    const tampered = { ...signed, rawBody: signed.rawBody.replace('"publishAttemptCount":1', '"publishAttemptCount":7') };

    expect(await flow.post(tampered)).toBe(204);
    await flow.idle();
    await flow.counters.flush();

    expect(tampered.rawBody).not.toBe(signed.rawBody);
    expect(flow.recordVerified).not.toHaveBeenCalled();
    expect(flow.totals().results).toEqual({ bad_signature: 1 });
    expect(flow.lines).toEqual([]);
  });

  it("fetches a key once an hour: 59 min later no fetch, at 60 min + 1 ms a refresh (A5)", async () => {
    const signer = createSigner();
    const flow = createFlow({ fetchFn: ebay(async () => Response.json({ key: signer.publicKey })) });

    await flow.post(signer.signed(notificationBody({ notificationId: "hour-1" })));
    await flow.idle();
    flow.advance(59 * 60_000);
    await flow.post(signer.signed(notificationBody({ notificationId: "hour-2" })));
    await flow.idle();
    expect(flow.keyCalls()).toBe(1);

    flow.advance(60_000 + 1);
    await flow.post(signer.signed(notificationBody({ notificationId: "hour-3" })));
    await flow.idle();

    expect(flow.keyCalls()).toBe(2);
    expect([...flow.rows.keys()]).toEqual(["hour-1", "hour-2", "hour-3"]);
  });

  it("keeps one row and makes one key fetch for the same notification sent 100 times (A5)", async () => {
    const signer = createSigner();
    const flow = createFlow({ fetchFn: ebay(async () => Response.json({ key: signer.publicKey })) });
    const notification = signer.signed(notificationBody({ notificationId: "repeat-1" }));

    const statuses = await Promise.all(Array.from({ length: 100 }, () => flow.post(notification)));
    await flow.idle();
    await flow.counters.flush();

    expect(statuses).toEqual(Array(100).fill(204));
    expect(flow.recordVerified).toHaveBeenCalledTimes(100);
    expect([...flow.rows.keys()]).toEqual(["repeat-1"]);
    expect(flow.keyCalls()).toBe(1);
    expect(flow.totals().results).toEqual({});
  });

  it("saves 1,500 signed notifications delivered at eBay's pace with one key fetch and none dropped (ADR 0013)", async () => {
    const signer = createSigner();
    const flow = createFlow({ fetchFn: ebay(async () => Response.json({ key: signer.publicKey })) });

    const statuses: number[] = [];
    for (let i = 0; i < 1_500; i += 1) {
      statuses.push(await flow.post(signer.signed(notificationBody({ notificationId: `paced-${i}` }))));
      await flow.idle();
    }
    await flow.counters.flush();

    expect(statuses).toEqual(Array(1_500).fill(204));
    expect(flow.rows.size).toBe(1_500);
    expect(flow.keyCalls()).toBe(1);
    expect(flow.totals().results.dropped ?? 0).toBe(0);
  });

  it("answers a burst of 1,500 signed POSTs with 204 and counts every one beyond the queue as dropped once", async () => {
    const signer = createSigner();
    const flow = createFlow({ fetchFn: ebay(async () => Response.json({ key: signer.publicKey })) });
    const notifications = Array.from({ length: 1_500 }, (_, i) =>
      signer.signed(notificationBody({ notificationId: `burst-${i}` })),
    );

    const statuses = await Promise.all(notifications.map((notification) => flow.post(notification)));
    await flow.idle();
    await flow.counters.flush();
    const dropped = flow.totals().results.dropped ?? 0;

    expect(statuses).toEqual(Array(1_500).fill(204));
    expect(flow.rows.size + dropped).toBe(1_500);
    expect(flow.rows.size).toBeGreaterThanOrEqual(1_000);
    expect(dropped).toBeLessThanOrEqual(500);
    expect(flow.totals().results).toEqual(dropped === 0 ? {} : { dropped });
  });

  it("makes at most 10 key fetches for 1,000 POSTs with random key ids and saves none (A21)", async () => {
    const signer = createSigner();
    const flow = createFlow({
      fetchFn: ebay(async () => Response.json({ errors: [{ errorId: 195000 }] }, { status: 404 })),
    });
    const notifications = Array.from({ length: 1_000 }, (_, i) =>
      signer.signed(notificationBody({ notificationId: `random-${i}` }), { kid: `kid-${randomUUID()}` }),
    );

    const statuses = await Promise.all(notifications.map((notification) => flow.post(notification)));
    await flow.idle();
    await flow.counters.flush();
    const { results, usage } = flow.totals();

    expect(statuses).toEqual(Array(1_000).fill(204));
    expect(flow.keyCalls()).toBeLessThanOrEqual(10);
    expect(flow.recordVerified).not.toHaveBeenCalled();
    expect((results.key_rejected ?? 0) + (results.key_fetch_limited ?? 0) + (results.dropped ?? 0)).toBe(1_000);
    expect(Object.keys(results).sort()).toEqual(
      ["dropped", "key_fetch_limited", "key_rejected"].filter((result) => results[result] !== undefined),
    );
    expect(usage["commerce.notification/deletion-key"]).toBe(flow.keyCalls());
    expect(usage["identity.oauth2/token"]).toBe(flow.tokenCalls());
    const limitedLines = flow.lines.filter((line) => line.result === "key_fetch_limited");
    expect(limitedLines).toHaveLength(results.key_fetch_limited ?? 0);
    expect(new Set(limitedLines.map((line) => line.notificationId)).size).toBe(limitedLines.length);
    const logged = JSON.stringify(flow.lines);
    for (const sentinel of USER_SENTINELS) expect(logged).not.toContain(sentinel);
  });

  it("caps the queue at 1,000 plus 4 running while the key fetch hangs, and counts the rest as dropped (A21)", async () => {
    const signer = createSigner();
    const flow = createFlow({ fetchFn: ebay(async (_kid, init) => hangingFetch("key", init)) });
    let maxHeld = 0;

    const statuses: number[] = [];
    for (let batch = 0; batch < 50; batch += 1) {
      const posts = Array.from({ length: 100 }, (_, i) =>
        flow
          .post(signer.signed(notificationBody({ notificationId: `hang-${batch}-${i}` }), { kid: `kid-${batch}-${i}` }))
          .then((status) => {
            maxHeld = Math.max(maxHeld, flow.queue.pending + flow.queue.running);
            return status;
          }),
      );
      statuses.push(...(await Promise.all(posts)));
      await new Promise((resolve) => setImmediate(resolve));
    }
    const held = flow.queue.pending + flow.queue.running;
    await flow.counters.flush();

    expect(statuses).toHaveLength(5_000);
    expect(statuses.every((status) => status === 204)).toBe(true);
    expect(maxHeld).toBeLessThanOrEqual(1_000 + 4);
    expect(flow.queue.running).toBe(4);
    expect(flow.totals().results).toEqual({ dropped: 5_000 - held });
    await flow.queue.drain(0);
  });

  it("verifies with the stale key while eBay answers 503 to the refresh", async () => {
    const signer = createSigner();
    let keyStatus = 200;
    const flow = createFlow({
      fetchFn: ebay(async () =>
        keyStatus === 200 ? Response.json({ key: signer.publicKey }) : new Response(null, { status: keyStatus }),
      ),
    });

    await flow.post(signer.signed(notificationBody({ notificationId: "stale-1" })));
    await flow.idle();
    keyStatus = 503;
    flow.advance(60 * 60_000 + 1);
    await flow.post(signer.signed(notificationBody({ notificationId: "stale-2" })));
    await flow.idle();
    await flow.counters.flush();

    expect([...flow.rows.keys()]).toEqual(["stale-1", "stale-2"]);
    expect(flow.keyCalls()).toBe(3);
    expect(flow.totals().results).toEqual({});
    expect(flow.totals().usage["commerce.notification/deletion-key"]).toBe(3);
  });

  it("answers 50 POSTs with 204 and counts the unfinished ones as dropped_on_shutdown on SIGTERM (A22)", async () => {
    const signer = createSigner("kid-known");
    const flow = createFlow({
      fetchFn: ebay(async (kid, init) =>
        kid === "kid-known" ? Response.json({ key: signer.publicKey }) : hangingFetch("key", init),
      ),
    });
    const statuses = [await flow.post(signer.signed(notificationBody({ notificationId: "known-0" })))];
    await flow.idle();
    for (let i = 1; i < 10; i += 1) {
      statuses.push(await flow.post(signer.signed(notificationBody({ notificationId: `known-${i}` }))));
    }
    for (let i = 0; i < 40; i += 1) {
      statuses.push(
        await flow.post(signer.signed(notificationBody({ notificationId: `unknown-${i}` }), { kid: `kid-unknown-${i}` })),
      );
    }
    await vi.waitFor(() => expect(flow.rows.size).toBe(10));
    const exit = vi.fn((code: number) => flow.events.push(`exit ${code}`));
    const shutdown = createShutdown({
      server: { close: () => undefined, closeIdleConnections: () => undefined, closeAllConnections: () => undefined },
      queue: flow.queue,
      counters: flow.counters,
      endPool: async () => {
        flow.events.push("endPool");
      },
      log: { ...flow.log, error: flow.log.warn, flush: () => undefined },
      now: () => performance.now(),
      exit,
      timing: { ...SHUTDOWN_TIMING, drainMs: 100 },
    });

    const done = shutdown("SIGTERM");
    statuses.push(await flow.post(signer.signed(notificationBody({ notificationId: "after-close" }))));
    await done;

    expect(statuses).toEqual(Array(51).fill(204));
    expect(flow.lines.find((line) => line.event === "shutdown")).toMatchObject({ dropped_on_shutdown: 50 - 10 });
    expect(flow.totals().results).toEqual({ dropped_on_shutdown: 41 });
    expect(flow.events.slice(-5)).toEqual(["log shutdown", "store", "endPool", "log shutdown_done", "exit 0"]);
    expect(exit.mock.calls).toEqual([[0]]);
  });
});
