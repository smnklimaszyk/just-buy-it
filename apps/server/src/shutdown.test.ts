import { createServer } from "node:http";
import { connect } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createDeletionCounters, type HourlyCounts } from "./deletion-counters.js";
import { createDeletionQueue } from "./deletion-queue.js";
import type { IncomingNotification } from "./app.js";
import { createNotificationWork, type VerifiedEvent } from "./notifications.js";
import { createShutdown, SHUTDOWN_TIMING, type ShutdownTiming } from "./shutdown.js";
import { createSigner, notificationBody } from "./testing/signed.js";

const clock = { now: () => new Date("2026-10-20T10:00:00Z") };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const fastTiming: ShutdownTiming = {
  drainMs: 100,
  closeConnectionsMs: 50,
  flushTimeoutMs: 200,
  poolEndMs: 100,
  hardStopMs: 5_000,
};

// A queue whose items hang in the key lookup until the drain aborts them.
function hangingQueue(events: string[]) {
  const counters = createDeletionCounters({
    clock,
    store: async (counts: HourlyCounts) => {
      events.push(`store ${JSON.stringify(counts.deletionResults.map((row) => [row.result, row.count]))}`);
    },
    log: { info: () => undefined, warn: () => undefined },
  });
  const queue = createDeletionQueue<number>({
    capacity: 1_000,
    concurrency: 4,
    work: (_item, { signal }) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
    onDropped: counters.countResult,
    onError: () => undefined,
  });
  return { counters, queue };
}

function fakeServer(events: string[]) {
  return {
    close: () => events.push("server.close"),
    closeIdleConnections: () => events.push("server.closeIdleConnections"),
    closeAllConnections: () => events.push("server.closeAllConnections"),
  };
}

describe("createShutdown", () => {
  it("drains, counts the unfinished items as dropped_on_shutdown, logs before the final flush, then ends the pool and exits 0", async () => {
    const events: string[] = [];
    const lines: Record<string, unknown>[] = [];
    const { counters, queue } = hangingQueue(events);
    for (let item = 0; item < 50; item += 1) queue.push(item);
    await nextTurn();
    const exit = vi.fn((code: number) => events.push(`exit ${code}`));
    const shutdown = createShutdown({
      server: fakeServer(events),
      queue,
      counters,
      endPool: async () => {
        events.push("endPool");
      },
      log: {
        info: (entry) => {
          lines.push(entry);
          events.push(`log ${String(entry.event)}`);
        },
        error: (entry) => lines.push(entry),
        flush: () => events.push("log.flush"),
      },
      now: () => performance.now(),
      exit,
      timing: fastTiming,
    });

    const done = shutdown("SIGTERM");
    queue.push(50);
    await done;

    expect(lines[0]).toMatchObject({
      event: "shutdown",
      signal: "SIGTERM",
      drained: false,
      dropped_on_shutdown: 50,
      unsaved_counts: { deletionResults: [{ result: "dropped_on_shutdown", count: 51 }], apiUsage: [] },
    });
    expect(lines[1]).toMatchObject({ event: "shutdown_done", counts_saved: true });
    expect(events).toEqual([
      "server.close",
      "server.closeIdleConnections",
      "server.closeAllConnections",
      "log shutdown",
      "log.flush",
      'store [["dropped_on_shutdown",51]]',
      "endPool",
      "log shutdown_done",
      "exit 0",
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("fits every step's worst case before the hard stop, and the hard stop before Compose's SIGKILL", () => {
    const { drainMs, flushTimeoutMs, poolEndMs, hardStopMs, closeConnectionsMs } = SHUTDOWN_TIMING;

    expect(drainMs + flushTimeoutMs + poolEndMs).toBeLessThan(hardStopMs);
    expect(hardStopMs).toBeLessThan(15_000);
    expect(closeConnectionsMs).toBeLessThan(drainMs);
  });

  describe("with fake timers and the real constants", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("exits 0 at 13 s when the drain, the final flush and the pool end all hang", async () => {
      vi.useFakeTimers();
      const { queue } = hangingQueue([]);
      const counters = createDeletionCounters({
        clock,
        store: () => new Promise<void>(() => undefined),
        log: { info: () => undefined, warn: () => undefined },
      });
      for (let item = 0; item < 10; item += 1) queue.push(item);
      await vi.advanceTimersByTimeAsync(0);
      const exit = vi.fn();
      const lines: Record<string, unknown>[] = [];
      const shutdown = createShutdown({
        server: fakeServer([]),
        queue,
        counters,
        endPool: () => new Promise<void>(() => undefined),
        log: { info: (entry) => lines.push(entry), error: () => undefined, flush: () => undefined },
        now: () => Date.now(),
        exit,
        timing: SHUTDOWN_TIMING,
      });

      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(12_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit.mock.calls).toEqual([[0]]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(exit.mock.calls).toEqual([[0]]);
      expect(lines.map((line) => line.event)).toEqual(["shutdown", "shutdown_done"]);
      expect(lines[0]).toMatchObject({ dropped_on_shutdown: 10, elapsed_ms: 10_000 });
      expect(lines[1]).toMatchObject({ counts_saved: false, elapsed_ms: 13_000 });
    });

    it.each([
      ["throws", () => Promise.reject(new Error("bug in drain"))],
      ["never returns control", () => new Promise<{ unfinished: number }>(() => undefined)],
    ])("exits 1 at the 14 s hard stop when queue.drain %s", async (_name, drain) => {
      vi.useFakeTimers();
      const exit = vi.fn();
      const shutdown = createShutdown({
        server: fakeServer([]),
        queue: { close: () => undefined, drain },
        counters: hangingQueue([]).counters,
        endPool: async () => undefined,
        log: { info: () => undefined, error: () => undefined, flush: () => undefined },
        now: () => Date.now(),
        exit,
        timing: SHUTDOWN_TIMING,
      });

      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(13_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(exit.mock.calls).toEqual([[1]]);
    });
  });

  it("keeps a verified item whose insert never ends out of dropped_on_shutdown; its line is already written", async () => {
    const lines: Record<string, unknown>[] = [];
    const stored: HourlyCounts[] = [];
    const signer = createSigner();
    const recordVerified = vi.fn<(event: VerifiedEvent) => Promise<"inserted">>(() => new Promise(() => undefined));
    const counters = createDeletionCounters({
      clock,
      store: async (counts) => {
        stored.push(counts);
      },
      log: { info: () => undefined, warn: () => undefined },
    });
    const queue = createDeletionQueue<IncomingNotification>({
      capacity: 1_000,
      concurrency: 4,
      work: createNotificationWork({
        lookupKey: async () => ({ kind: "key", key: signer.publicKey, stale: false }),
        countResult: counters.countResult,
        recordVerified,
        log: { info: (entry) => lines.push(entry), warn: (entry) => lines.push(entry) },
        clock,
      }),
      onDropped: counters.countResult,
      onError: () => undefined,
    });
    queue.push(signer.signed(notificationBody({ notificationId: "verified-1" })));
    await vi.waitFor(() => expect(recordVerified).toHaveBeenCalledTimes(1));
    const exit = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer([]),
      queue,
      counters,
      endPool: async () => undefined,
      log: { info: (entry) => lines.push(entry), error: (entry) => lines.push(entry), flush: () => undefined },
      now: () => performance.now(),
      exit,
      timing: fastTiming,
    });

    await shutdown("SIGTERM");

    expect(lines[0]).toMatchObject({ event: "ebay_account_deletion", result: "verified", notificationId: "verified-1" });
    expect(recordVerified.mock.calls[0]).toHaveLength(1);
    expect(lines.find((line) => line.event === "shutdown")).toMatchObject({ drained: true, dropped_on_shutdown: 0 });
    expect(stored).toEqual([]);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("closes a connection that stalls mid-body and exits 0 without waiting for it", async () => {
    const { counters, queue } = hangingQueue([]);
    const app = createApp({
      endpointUrl: "https://deals.intra-ai.de/ebay/account-deletion",
      verificationToken: "t".repeat(64),
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      probeCode: "p".repeat(40),
      onProbe: () => undefined,
      onNotification: () => undefined,
    });
    const server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server is not listening on a TCP port");
    const client = connect(address.port, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", resolve));
    const clientClosed = new Promise<number>((resolve) => client.once("close", () => resolve(performance.now())));
    client.on("error", () => undefined);
    client.write(
      "POST /ebay/account-deletion HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n0123456789",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    let exitedAt = 0;
    const shutdown = createShutdown({
      server,
      queue,
      counters,
      endPool: async () => undefined,
      log: { info: () => undefined, error: () => undefined, flush: () => undefined },
      now: () => performance.now(),
      exit: (code) => {
        if (code === 0) exitedAt = performance.now();
      },
      timing: { drainMs: 300, closeConnectionsMs: 50, flushTimeoutMs: 200, poolEndMs: 100, hardStopMs: 5_000 },
    });

    const started = performance.now();
    await shutdown("SIGTERM");
    const closedAt = await clientClosed;

    expect(exitedAt - started).toBeLessThan(300 + 200 + 100);
    expect(closedAt - started).toBeLessThan(1_000);
    expect(server.listening).toBe(false);
  });

  it("does nothing on a second signal", async () => {
    const events: string[] = [];
    const { counters, queue } = hangingQueue(events);
    const exit = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer(events),
      queue,
      counters,
      endPool: async () => undefined,
      log: { info: () => undefined, error: () => undefined, flush: () => undefined },
      now: () => performance.now(),
      exit,
      timing: fastTiming,
    });

    const first = shutdown("SIGTERM");
    await shutdown("SIGTERM");
    await shutdown("SIGINT");
    await first;

    expect(events.filter((event) => event === "server.close")).toHaveLength(1);
    expect(exit.mock.calls).toEqual([[0]]);
  });
});
