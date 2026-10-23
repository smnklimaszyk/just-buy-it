import {
  claimDelivery,
  expireDelivery,
  failDelivery,
  getDeliveryForSend,
  holdDelivery,
  markDeliverySent,
  pauseSmtp,
  scheduleDeliveryRetry,
  sendTimesSince,
  smtpPausedUntil,
  type DbPool,
  type DeliveryForSend,
  type HoldReason,
  type Queryable,
} from "@ebay-sniper/db";
import type { JobHandler } from "@ebay-sniper/db/queue";
import { checkEmailRate, startOfBerlinDay, type Clock } from "@ebay-sniper/domain";
import { SmtpError, type SmtpMailer, type SmtpSendResult } from "@ebay-sniper/notify";
import type { LogFn } from "./poll.js";

export type SendDeps = {
  pool: DbPool;
  clock: Clock;
  // null while SMTP is not configured.
  mailer: SmtpMailer | null;
  log: { info: LogFn; warn: LogFn };
};

const HOUR_MS = 60 * 60_000;

// Section 6.5: EAUTH holds all sends this long.
const SMTP_PAUSE_MS = 15 * 60_000;

// Relay re-checks a delivery held for missing SMTP settings after this.
const NOT_CONFIGURED_RECHECK_MS = 5 * 60_000;

// The claim's condition: pending and due, or sending past its lease.
function isDue(delivery: DeliveryForSend, now: Date): boolean {
  if (delivery.status === "pending") return delivery.nextAttemptAt <= now;
  return delivery.status === "sending" && delivery.leaseUntil !== null && delivery.leaseUntil < now;
}

// Spec 2.1 and 9: the people of the alert's product who are active now, read when the email goes
// out, without the delivery's own recipient (ALERT_TO). A key with no product (a segment alert
// made before v2) has nobody.
async function productPeople(db: Queryable, delivery: DeliveryForSend): Promise<string[]> {
  const result = await db.query<{ email: string }>(
    `SELECT u.email::text AS email
       FROM app.alert a
       JOIN app.product p ON p.key = a.segment
       JOIN auth.app_user u ON u.id = ANY (p.alert_recipient_ids)
      WHERE a.id = $1 AND u.status = 'active' AND u.email <> $2::citext
      ORDER BY u.email`,
    [delivery.alertId, delivery.recipient],
  );
  return result.rows.map((row) => row.email);
}

// A send gate failed (section 2.4): the delivery waits with the reason; attempt is unchanged.
async function hold(deps: SendDeps, delivery: DeliveryForSend, holdReason: HoldReason, nextAttemptAt: Date, now: Date): Promise<void> {
  await holdDelivery(deps.pool, delivery.id, { holdReason, nextAttemptAt, now });
  deps.log.info({
    event: "delivery",
    delivery_id: delivery.id,
    status: "pending",
    hold_reason: holdReason,
    attempt: delivery.attempt,
    smtp_code: null,
  });
}

// Section 2.4: the claim is the only statement that increments attempt; the result is written
// fenced on it.
export function createSendHandler(deps: SendDeps): JobHandler<"send"> {
  return async ({ deliveryId }, job) => {
    const now = deps.clock.now();
    const delivery = await getDeliveryForSend(deps.pool, deliveryId);
    // Only a due delivery runs the gates: a held or backed-off one keeps its next_attempt_at, and a
    // finished one is left alone.
    if (delivery === null || !isDue(delivery, now)) return;
    // Gate 1: SMTP unset holds the delivery 5 minutes.
    const mailer = deps.mailer;
    if (mailer === null) {
      await hold(deps, delivery, "smtp_not_configured", new Date(now.getTime() + NOT_CONFIGURED_RECHECK_MS), now);
      return;
    }
    // Gate 2: while SMTP is paused after EAUTH, hold until the pause ends.
    const pausedUntil = await smtpPausedUntil(deps.pool, now);
    if (pausedUntil !== null) {
      await hold(deps, delivery, "smtp_paused", pausedUntil, now);
      return;
    }
    // Gate 3: a delivery whose message is gone (expired) is never sent.
    const message = delivery.message;
    if (message === null) {
      await expireDelivery(deps.pool, delivery.id, now);
      deps.log.info({ event: "delivery", delivery_id: delivery.id, status: "expired", hold_reason: null, attempt: delivery.attempt, smtp_code: null });
      return;
    }
    // Gate 4: at most 10 emails per rolling hour and 60 per Berlin day, counted
    // over deliveries in sending or sent; over it, hold until enough sends leave the window.
    const since = new Date(Math.min(startOfBerlinDay(now).getTime(), now.getTime() - HOUR_MS));
    const rate = checkEmailRate(await sendTimesSince(deps.pool, since), now);
    if (!rate.ok) {
      await hold(deps, delivery, "rate_limit", rate.nextAttemptAt, now);
      return;
    }
    const attempt = await claimDelivery(deps.pool, deliveryId, now);
    if (attempt === null) return;
    const bcc = await productPeople(deps.pool, delivery);
    let result: SmtpSendResult;
    try {
      result = await mailer.send(
        {
          deliveryId,
          to: delivery.recipient,
          bcc,
          subject: message.subject,
          text: message.textBody,
          html: message.htmlBody,
        },
        job.signal,
      );
    } catch (error) {
      if (!(error instanceof SmtpError)) throw error;
      const failedAt = deps.clock.now();
      // A permanent 5xx other than auth fails the delivery for good.
      if (error.kind === "failed") {
        await failDelivery(deps.pool, deliveryId, attempt, { lastErrorCode: error.code, now: failedAt });
        deps.log.info({
          event: "delivery",
          delivery_id: deliveryId,
          status: "failed",
          hold_reason: null,
          attempt,
          smtp_code: error.responseCode,
        });
        return;
      }
      // EAUTH: every send is held 15 minutes and the delivery stays pending until the pause ends.
      // Logged once per pause.
      let pauseEnd: Date | null = null;
      if (error.kind === "auth") {
        const alreadyPaused = (await smtpPausedUntil(deps.pool, failedAt)) !== null;
        pauseEnd = new Date(failedAt.getTime() + SMTP_PAUSE_MS);
        await pauseSmtp(deps.pool, pauseEnd);
        if (!alreadyPaused) deps.log.warn({ event: "smtp_paused", until: pauseEnd.toISOString() });
      }
      // A transient failure goes back to pending with the backoff; relay is the one retry path.
      // The SMTP error carries the code only, never the AUTH exchange.
      await scheduleDeliveryRetry(deps.pool, deliveryId, attempt, {
        lastErrorCode: error.code,
        now: failedAt,
        ...(pauseEnd === null ? {} : { nextAttemptAt: pauseEnd }),
      });
      deps.log.info({
        event: "delivery",
        delivery_id: deliveryId,
        status: "pending",
        hold_reason: null,
        attempt,
        smtp_code: error.responseCode,
      });
      return;
    }
    await markDeliverySent(deps.pool, deliveryId, attempt, { smtpMessageId: result.messageId, now: deps.clock.now() });
    deps.log.info({ event: "delivery", delivery_id: deliveryId, status: "sent", hold_reason: null, attempt, smtp_code: result.responseCode });
  };
}
