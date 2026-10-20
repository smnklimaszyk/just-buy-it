import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { limitConcurrency, processNotification, type NotificationLog } from "./notifications.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");

const body = {
  metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0", deprecated: false },
  notification: {
    notificationId: "49feeaeb-4982-42d9-a377-9645b8479411_33f7e043",
    eventDate: "2026-10-19T20:43:59.462Z",
    publishDate: "2026-10-19T20:43:59.679Z",
    publishAttemptCount: 1,
    data: { username: "secret-username", userId: "secret-user-id", eiasToken: "secret-eias-token" },
  },
};

function signedHeader(payload: unknown): string {
  const signature = sign("sha1", Buffer.from(JSON.stringify(payload)), privateKey).toString("base64");
  return Buffer.from(JSON.stringify({ alg: "ecdsa", kid: "kid-1", signature, digest: "SHA1" })).toString("base64");
}

describe("limitConcurrency", () => {
  it("drops work beyond the limit while earlier work is still running, and accepts more once it finishes", async () => {
    const finishers: (() => void)[] = [];
    const dropped: number[] = [];
    const run = limitConcurrency(
      2,
      () => new Promise<void>((resolve) => finishers.push(resolve)),
      (n: number) => dropped.push(n),
    );

    run(1);
    run(2);
    run(3);
    expect(dropped).toEqual([3]);

    finishers[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    run(4);
    expect(dropped).toEqual([3]);
  });
});

describe("processNotification", () => {
  it("logs a verified deletion notification without any user identifier", async () => {
    const logs: NotificationLog[] = [];

    await processNotification(
      { rawBody: JSON.stringify(body), signatureHeader: signedHeader(body) },
      { getKey: async () => pem, log: (entry) => logs.push(entry) },
    );

    expect(logs).toEqual([
      {
        event: "ebay_account_deletion",
        verified: true,
        topic: "MARKETPLACE_ACCOUNT_DELETION",
        notificationId: body.notification.notificationId,
        eventDate: body.notification.eventDate,
        publishAttemptCount: 1,
      },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/secret-/);
  });

  it("logs an unverified notification with a reason when the signature header is missing", async () => {
    const logs: NotificationLog[] = [];

    await processNotification(
      { rawBody: JSON.stringify(body), signatureHeader: undefined },
      { getKey: async () => pem, log: (entry) => logs.push(entry) },
    );

    expect(logs).toEqual([{ event: "ebay_account_deletion", verified: false, reason: "missing signature header" }]);
  });

  it("logs instead of throwing when the body is not valid JSON", async () => {
    const logs: NotificationLog[] = [];

    await processNotification(
      { rawBody: "{not json", signatureHeader: signedHeader(body) },
      { getKey: async () => pem, log: (entry) => logs.push(entry) },
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "ebay_account_deletion", verified: false });
    expect(logs[0]).toHaveProperty("reason");
  });

  it("logs instead of throwing when the JSON does not have the notification shape", async () => {
    const logs: NotificationLog[] = [];

    await processNotification(
      { rawBody: JSON.stringify({ hello: "world" }), signatureHeader: signedHeader({ hello: "world" }) },
      { getKey: async () => pem, log: (entry) => logs.push(entry) },
    );

    expect(logs).toEqual([{ event: "ebay_account_deletion", verified: false, reason: "unexpected notification shape" }]);
  });

  it("logs a fixed reason for a malformed signature header instead of the parser message", async () => {
    const logs: NotificationLog[] = [];
    const header = Buffer.from('{"kid":"secret-from-attacker"').toString("base64");

    await processNotification(
      { rawBody: JSON.stringify(body), signatureHeader: header },
      { getKey: async () => pem, log: (entry) => logs.push(entry) },
    );

    expect(logs).toEqual([
      {
        event: "ebay_account_deletion",
        verified: false,
        reason: "invalid signature header",
        notificationId: body.notification.notificationId,
      },
    ]);
  });

  it("does not copy an oversized notification id into the log", async () => {
    const logs: NotificationLog[] = [];
    const flood = { ...body, notification: { ...body.notification, notificationId: "x".repeat(60_000) } };

    await processNotification(
      { rawBody: JSON.stringify(flood), signatureHeader: signedHeader(flood) },
      { getKey: async () => pem, log: (entry) => logs.push(entry) },
    );

    expect(logs).toEqual([{ event: "ebay_account_deletion", verified: false, reason: "unexpected notification shape" }]);
  });

  it("logs the failure with the notification id when the public key lookup fails", async () => {
    const logs: NotificationLog[] = [];

    await processNotification(
      { rawBody: JSON.stringify(body), signatureHeader: signedHeader(body) },
      {
        getKey: async () => {
          throw new Error("eBay token request failed with status 401");
        },
        log: (entry) => logs.push(entry),
      },
    );

    expect(logs).toEqual([
      {
        event: "ebay_account_deletion",
        verified: false,
        reason: "eBay token request failed with status 401",
        notificationId: body.notification.notificationId,
      },
    ]);
  });
});
