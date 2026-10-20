import { request, Agent } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createPublicKeyClient, type FetchFn } from "@ebay-sniper/ebay";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type IncomingNotification } from "./app.js";
import { createDeletionQueue } from "./deletion-queue.js";
import { createNotificationWork } from "./notifications.js";
import { createSigner, notificationBody } from "./testing/signed.js";

const clock = { now: () => new Date("2026-10-20T10:00:00Z") };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function listeningAddress(address: AddressInfo | string | null): AddressInfo {
  if (address === null || typeof address === "string") throw new Error("server is not listening on a TCP port");
  return address;
}

type Reply = { status: number; body: string; reusedSocket: boolean; elapsedMs: number };

// node:http as the client: the global fetch fails every server test (vitest.setup.ts).
function post(port: number, agent: Agent, notification: IncomingNotification): Promise<Reply> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/ebay/account-deletion",
        method: "POST",
        agent,
        headers: { "content-type": "application/json", "x-ebay-signature": notification.signatureHeader ?? "" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, reusedSocket: req.reusedSocket, elapsedMs: performance.now() - started }),
        );
      },
    );
    req.on("error", reject);
    req.end(notification.rawBody);
  });
}

describe("POST /ebay/account-deletion over a real socket", () => {
  it("answers 204 with an empty body within 1 s while the key fetch hangs, twice on one keep-alive connection (A2)", async () => {
    const fetchFn = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const { lookupKey } = createPublicKeyClient({
      apiBase: "https://api.ebay.test",
      token: { get: async () => "app-token", invalidate: () => undefined },
      fetchFn,
      clock,
      timeoutMs: 60_000,
    });
    const queue = createDeletionQueue<IncomingNotification>({
      capacity: 1_000,
      concurrency: 4,
      work: createNotificationWork({
        lookupKey,
        countResult: () => undefined,
        recordVerified: async () => "inserted",
        log: { info: () => undefined, warn: () => undefined },
        clock,
      }),
      onDropped: () => undefined,
      onError: () => undefined,
    });
    const app = createApp({
      endpointUrl: "https://deals.intra-ai.de/ebay/account-deletion",
      verificationToken: "t".repeat(64),
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      probeCode: "p".repeat(40),
      onProbe: () => undefined,
      onNotification: queue.push,
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = listeningAddress(server.address());
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(async () => {
      agent.destroy();
      await queue.drain(0);
      await new Promise((resolve) => server.close(resolve));
    });
    const signer = createSigner("kid-socket");

    const first = await post(port, agent, signer.signed(notificationBody({ notificationId: "socket-1" })));
    const second = await post(port, agent, signer.signed(notificationBody({ notificationId: "socket-2" })));

    expect(first).toMatchObject({ status: 204, body: "" });
    expect(first.elapsedMs).toBeLessThan(1_000);
    expect(second).toMatchObject({ status: 204, body: "", reusedSocket: true });
    expect(second.elapsedMs).toBeLessThan(1_000);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/public_key/kid-socket");
  });
});
