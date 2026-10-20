import { generateKeyPairSync, sign } from "node:crypto";
import type { IncomingNotification } from "../app.js";

// Test helpers for signed eBay deletion notifications with a synthetic ECDSA key. Not built.

// The user identifiers eBay sends in notification.data. No log line, row or count may contain them.
export const USER_SENTINELS = ["secret-username", "secret-user-id", "secret-eias-token"] as const;

export type NotificationFields = {
  notificationId: string;
  topic: string;
  eventDate: string;
  publishAttemptCount: number;
};

export function notificationBody(fields: Partial<NotificationFields> = {}) {
  return {
    metadata: { topic: fields.topic ?? "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0", deprecated: false },
    notification: {
      notificationId: fields.notificationId ?? "49feeaeb-4982-42d9-a377-9645b8479411_33f7e043",
      eventDate: fields.eventDate ?? "2026-10-19T20:43:59.462Z",
      publishDate: "2026-10-19T20:43:59.679Z",
      publishAttemptCount: fields.publishAttemptCount ?? 1,
      data: { username: USER_SENTINELS[0], userId: USER_SENTINELS[1], eiasToken: USER_SENTINELS[2] },
    },
  };
}

// The x-ebay-signature header: base64 of a JSON object. A field set to undefined is left out.
export function encodeHeader(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(fields)).toString("base64");
}

// eBay signs JSON.stringify of the body with ECDSA over SHA-1 and serves the key as one-line PEM.
export function createSigner(kid = "kid-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  function header(payload: unknown, fields: Record<string, unknown> = {}): string {
    const signature = sign("sha1", Buffer.from(JSON.stringify(payload)), privateKey).toString("base64");
    return encodeHeader({ alg: "ecdsa", kid, signature, digest: "SHA1", ...fields });
  }

  function signed(payload: unknown, fields: Record<string, unknown> = {}): IncomingNotification {
    return { rawBody: JSON.stringify(payload), signatureHeader: header(payload, fields) };
  }

  return {
    kid,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, ""),
    header,
    signed,
  };
}
