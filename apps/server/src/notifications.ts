import type { ClockLike, EbayErrorKind, KeyLookup } from "@ebay-sniper/ebay";
import { z } from "zod";
import type { IncomingNotification } from "./app.js";
import { parseSignatureHeader, verifySignature } from "./deletion.js";

// Every result except verified is added to app.deletion_result_hourly (spec S3, section 2.1).
export type DeletionResult =
  | "malformed"
  | "unsupported_alg"
  | "key_rejected"
  | "key_fetch_limited"
  | "key_unavailable"
  | "bad_signature"
  | "dropped"
  | "dropped_on_shutdown";

// The audit row of ADR 0013: no username, userId, eiasToken or body.
export type VerifiedEvent = { notificationId: string; topic: string; eventDate: Date; publishAttemptCount: number };

export type Classified =
  | { result: "verified"; event: VerifiedEvent }
  | { result: "key_unavailable"; notificationId: string; errKind: EbayErrorKind }
  | { result: "key_fetch_limited"; notificationId: string }
  | { result: "key_rejected" | "bad_signature"; notificationId: string }
  | { result: "malformed" | "unsupported_alg"; notificationId?: string };

export type LookupKey = (kid: string, signal?: AbortSignal) => Promise<KeyLookup>;

export type WorkContext = { signal: AbortSignal; classified: () => void };

const HOUR_MS = 60 * 60_000;
const KEY_LINES_PER_HOUR = 1_000;

// Only the audit fields, within the limits of the deletion_event columns. The user identifiers in
// notification.data are never read.
const notificationSchema = z.object({
  metadata: z.object({ topic: z.string().min(1).max(64) }),
  notification: z.object({
    notificationId: z.string().min(1).max(128),
    eventDate: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    publishAttemptCount: z.number().int().min(0).max(2_147_483_647),
  }),
});

export async function processNotification(
  incoming: IncomingNotification,
  deps: { lookupKey: LookupKey; signal: AbortSignal },
): Promise<Classified> {
  let body: unknown;
  try {
    body = JSON.parse(incoming.rawBody);
  } catch {
    return { result: "malformed" };
  }
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) return { result: "malformed" };
  const { metadata, notification } = parsed.data;
  const { notificationId } = notification;

  if (!incoming.signatureHeader) return { result: "malformed", notificationId };
  const header = parseSignatureHeader(incoming.signatureHeader);
  if (!header.ok) return { result: header.result, notificationId };

  const lookup = await deps.lookupKey(header.kid, deps.signal);
  if (lookup.kind === "rejected") return { result: "key_rejected", notificationId };
  if (lookup.kind === "limited") return { result: "key_fetch_limited", notificationId };
  if (lookup.kind === "unavailable") return { result: "key_unavailable", notificationId, errKind: lookup.error.kind };

  if (!signatureMatches(body, header.signature, lookup.key)) return { result: "bad_signature", notificationId };
  return {
    result: "verified",
    event: {
      notificationId,
      topic: metadata.topic,
      eventDate: notification.eventDate,
      publishAttemptCount: notification.publishAttemptCount,
    },
  };
}

export type LogFn = (entry: Record<string, unknown>) => void;

export type NotificationWorkDeps = {
  lookupKey: LookupKey;
  countResult: (result: DeletionResult) => void;
  recordVerified: (event: VerifiedEvent) => Promise<"inserted" | "updated">;
  log: { info: LogFn; warn: LogFn };
  clock: ClockLike;
};

// The queue's work: classify, count or log, mark the item classified, then save a verified event.
export function createNotificationWork(deps: NotificationWorkDeps) {
  let lineHour = -1;
  let linesThisHour = 0;

  // A genuine notification lost to an eBay outage or the fetch budget can be matched with eBay's
  // retry by its id. Other results get no line each, and these stop after 1,000 in a UTC hour, so a
  // flood cannot rotate the log. The counts stay complete.
  function logKeyResult(classified: Extract<Classified, { result: "key_unavailable" | "key_fetch_limited" }>): void {
    const hour = Math.floor(deps.clock.now().getTime() / HOUR_MS);
    if (hour !== lineHour) {
      lineHour = hour;
      linesThisHour = 0;
    }
    if (linesThisHour >= KEY_LINES_PER_HOUR) return;
    linesThisHour += 1;
    const { result, notificationId } = classified;
    deps.log.warn(
      classified.result === "key_unavailable"
        ? { event: "ebay_account_deletion", result, notificationId, err_kind: classified.errKind }
        : { event: "ebay_account_deletion", result, notificationId },
    );
  }

  return async (incoming: IncomingNotification, context: WorkContext): Promise<void> => {
    const classified = await processNotification(incoming, { lookupKey: deps.lookupKey, signal: context.signal });
    // The drain has already counted this item as dropped_on_shutdown.
    if (context.signal.aborted) return;
    if (classified.result !== "verified") {
      deps.countResult(classified.result);
      context.classified();
      if (classified.result === "key_unavailable" || classified.result === "key_fetch_limited") {
        logKeyResult(classified);
      }
      return;
    }

    const { event } = classified;
    // Written before the insert, so the audit fact is in the log even if the insert never ends.
    deps.log.info({
      event: "ebay_account_deletion",
      result: "verified",
      notificationId: event.notificationId,
      topic: event.topic,
      eventDate: event.eventDate.toISOString(),
      publishAttemptCount: event.publishAttemptCount,
    });
    context.classified();
    // No signal: once verified, the insert runs to its own end, bounded by the pool timeouts.
    try {
      const outcome = await deps.recordVerified(event);
      deps.log.info({ event: "ebay_account_deletion_saved", notificationId: event.notificationId, saved: true, outcome });
    } catch (error) {
      deps.log.warn({
        event: "ebay_account_deletion_saved",
        notificationId: event.notificationId,
        saved: false,
        err_code: errorCode(error),
      });
    }
  };
}

// The SQLSTATE or Node error code, or "timeout" for the pg client and pool timeouts, which carry no
// code. Never the message, which may quote a statement or a value.
function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
    if (/timeout/i.test(error.message)) return "timeout";
  }
  return "unknown";
}

// Bad signature bytes or a key Node cannot parse make verify throw; both mean the check failed.
function signatureMatches(body: unknown, signature: string, key: string): boolean {
  try {
    return verifySignature(body, signature, key);
  } catch {
    return false;
  }
}
