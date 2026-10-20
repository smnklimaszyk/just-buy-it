import { z } from "zod";
import type { IncomingNotification } from "./app.js";
import { parseSignatureHeader, verifySignature, type SignatureHeader } from "./deletion.js";

export type NotificationLog =
  | {
      event: "ebay_account_deletion";
      verified: boolean;
      topic: string;
      notificationId: string;
      eventDate: string;
      publishAttemptCount: number;
    }
  | { event: "ebay_account_deletion"; verified: false; reason: string; notificationId?: string };

export type NotificationDeps = {
  getKey: (kid: string) => Promise<string>;
  log: (entry: NotificationLog) => void;
};

// Only the fields we log. The user identifiers in notification.data are never read.
const notificationSchema = z.object({
  metadata: z.object({ topic: z.string().max(64) }),
  notification: z.object({
    notificationId: z.string().max(128),
    eventDate: z.string().max(40),
    publishAttemptCount: z.number(),
  }),
});

// The task must handle its own errors; work beyond the limit is dropped, not queued.
export function limitConcurrency<T>(max: number, task: (item: T) => Promise<void>, onDrop: (item: T) => void) {
  let running = 0;
  return (item: T): void => {
    if (running >= max) {
      onDrop(item);
      return;
    }
    running += 1;
    void task(item).finally(() => {
      running -= 1;
    });
  };
}

export async function processNotification(incoming: IncomingNotification, deps: NotificationDeps): Promise<void> {
  if (!incoming.signatureHeader) {
    deps.log({ event: "ebay_account_deletion", verified: false, reason: "missing signature header" });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(incoming.rawBody);
  } catch {
    // JSON.parse messages quote the input, which may hold user identifiers, so log a fixed reason.
    deps.log({ event: "ebay_account_deletion", verified: false, reason: "invalid JSON body" });
    return;
  }
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) {
    deps.log({ event: "ebay_account_deletion", verified: false, reason: "unexpected notification shape" });
    return;
  }
  const { metadata, notification } = parsed.data;
  const failed = (reason: string) =>
    deps.log({ event: "ebay_account_deletion", verified: false, reason, notificationId: notification.notificationId });

  let header: SignatureHeader;
  try {
    header = parseSignatureHeader(incoming.signatureHeader);
  } catch {
    failed("invalid signature header");
    return;
  }

  let verified: boolean;
  try {
    verified = verifySignature(body, header.signature, await deps.getKey(header.kid));
  } catch (error) {
    // Key lookup errors are raised by our own eBay client and carry no request input.
    failed(error instanceof Error ? error.message : "signature check failed");
    return;
  }

  deps.log({
    event: "ebay_account_deletion",
    verified,
    topic: metadata.topic,
    notificationId: notification.notificationId,
    eventDate: notification.eventDate,
    publishAttemptCount: notification.publishAttemptCount,
  });
}
