import type { Queryable } from "./pool.js";

// Sections 2.4, 6.4 and 6.5: one delivery per alert and recipient. attempt counts real SMTP
// attempts: only claimDelivery increments it, holds never do.

export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "expired";
export type HoldReason = "smtp_not_configured" | "smtp_paused" | "rate_limit";

export const MAX_DELIVERY_ATTEMPTS = 5;
export const SEND_LEASE_MS = 60_000;

// In the screen or enrich result transaction. A repeat returns the existing delivery.
export async function insertDelivery(
  db: Queryable,
  input: { alertId: string; recipient: string; now: Date },
): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO app.alert_delivery (alert_id, channel, recipient, status, attempt, next_attempt_at, created_at, updated_at)
     VALUES ($1, 'email', $2, 'pending', 0, $3, $3, $3)
     ON CONFLICT (alert_id, recipient) DO NOTHING
     RETURNING id`,
    [input.alertId, input.recipient, input.now],
  );
  const id = inserted.rows[0]?.id;
  if (id !== undefined) return id;
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM app.alert_delivery WHERE alert_id = $1 AND recipient = $2",
    [input.alertId, input.recipient],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId === undefined) throw new Error("delivery insert conflicted but no delivery exists");
  return existingId;
}

export type AlertMessageInput = {
  deliveryId: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  // The listing's content_expires_at: an expired message is never sent.
  expiresAt: Date;
};

export async function insertAlertMessage(db: Queryable, message: AlertMessageInput): Promise<void> {
  await db.query(
    `INSERT INTO ebay_live.alert_message (delivery_id, subject, text_body, html_body, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [message.deliveryId, message.subject, message.textBody, message.htmlBody, message.expiresAt],
  );
}

// A send gate failed before the claim (section 2.4): the delivery stays pending with the reason
// and waits until nextAttemptAt. attempt is unchanged. A sending row past its lease (the send
// was lost) goes back to pending. False when it is neither.
export async function holdDelivery(
  db: Queryable,
  deliveryId: string,
  hold: { holdReason: HoldReason; nextAttemptAt: Date; now: Date },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE app.alert_delivery
        SET status = 'pending', hold_reason = $2, next_attempt_at = $3, lease_until = NULL, updated_at = $4
      WHERE id = $1 AND (status = 'pending' OR (status = 'sending' AND lease_until < $4))`,
    [deliveryId, hold.holdReason, hold.nextAttemptAt, hold.now],
  );
  return result.rowCount === 1;
}

// The only statement that increments attempt. Returns the attempt to fence the result on, or
// null when the delivery is not due, is leased by another send, or used its 5 attempts.
export async function claimDelivery(db: Queryable, deliveryId: string, now: Date): Promise<number | null> {
  const result = await db.query<{ attempt: number }>(
    `UPDATE app.alert_delivery
        SET status = 'sending', attempt = attempt + 1, lease_until = $2, hold_reason = NULL, updated_at = $3
      WHERE id = $1 AND attempt < $4
        AND ((status = 'pending' AND next_attempt_at <= $3) OR (status = 'sending' AND lease_until < $3))
      RETURNING attempt`,
    [deliveryId, new Date(now.getTime() + SEND_LEASE_MS), now, MAX_DELIVERY_ATTEMPTS],
  );
  return result.rows[0]?.attempt ?? null;
}

// Accepted by the SMTP server. Fenced on the claimed attempt.
export async function markDeliverySent(
  db: Queryable,
  deliveryId: string,
  attempt: number,
  result: { smtpMessageId: string | null; now: Date },
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE app.alert_delivery
        SET status = 'sent', sent_at = $3, smtp_message_id = $4, lease_until = NULL, last_error_code = NULL, updated_at = $3
      WHERE id = $1 AND attempt = $2 AND status = 'sending'`,
    [deliveryId, attempt, result.now, result.smtpMessageId],
  );
  return updated.rowCount === 1;
}

// Backoff after a transient failure of attempt n (1 to 4): 1, 5, 15, 30 minutes.
const BACKOFF_MINUTES = [1, 5, 15, 30];

export function retryDelayMs(attempt: number): number {
  const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempt, 1), BACKOFF_MINUTES.length) - 1] ?? 30;
  return minutes * 60_000;
}

// A transient failure (4xx, connection, timeout, TLS; EAUTH with the pause end as nextAttemptAt):
// back to pending for relay, or failed after the fifth real attempt. Fenced on the attempt.
export async function scheduleDeliveryRetry(
  db: Queryable,
  deliveryId: string,
  attempt: number,
  failure: { lastErrorCode: string; now: Date; nextAttemptAt?: Date },
): Promise<boolean> {
  const next = failure.nextAttemptAt ?? new Date(failure.now.getTime() + retryDelayMs(attempt));
  const updated = await db.query(
    `UPDATE app.alert_delivery
        SET status = CASE WHEN attempt >= $5 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = CASE WHEN attempt >= $5 THEN next_attempt_at ELSE $4 END,
            last_error_code = $3, lease_until = NULL, updated_at = $6
      WHERE id = $1 AND attempt = $2 AND status = 'sending'`,
    [deliveryId, attempt, failure.lastErrorCode, next, MAX_DELIVERY_ATTEMPTS, failure.now],
  );
  return updated.rowCount === 1;
}

// A permanent failure (5xx other than auth). Fenced on the attempt.
export async function failDelivery(
  db: Queryable,
  deliveryId: string,
  attempt: number,
  failure: { lastErrorCode: string; now: Date },
): Promise<boolean> {
  const updated = await db.query(
    `UPDATE app.alert_delivery SET status = 'failed', last_error_code = $3, lease_until = NULL, updated_at = $4
      WHERE id = $1 AND attempt = $2 AND status = 'sending'`,
    [deliveryId, attempt, failure.lastErrorCode, failure.now],
  );
  return updated.rowCount === 1;
}

// Send gate 3: the message expired, so the delivery is never sent. Also a sending row past its lease.
export async function expireDelivery(db: Queryable, deliveryId: string, now: Date): Promise<boolean> {
  const updated = await db.query(
    `UPDATE app.alert_delivery SET status = 'expired', lease_until = NULL, updated_at = $2
      WHERE id = $1 AND (status = 'pending' OR (status = 'sending' AND lease_until < $2))`,
    [deliveryId, now],
  );
  return updated.rowCount === 1;
}

// Relay: a sending row past its lease on the fifth attempt can never be claimed again, so it
// becomes failed with lease_lost. Returns the ids.
export async function failLostDeliveries(db: Queryable, now: Date): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE app.alert_delivery
        SET status = 'failed', last_error_code = 'lease_lost', lease_until = NULL, updated_at = $1
      WHERE status = 'sending' AND lease_until < $1 AND attempt >= $2
      RETURNING id`,
    [now, MAX_DELIVERY_ATTEMPTS],
  );
  return result.rows.map((row) => row.id);
}

// Relay, the one retry path for send: pending deliveries that are due and sending ones past their
// lease, oldest first.
export async function deliveriesDue(db: Queryable, now: Date, limit: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM app.alert_delivery
      WHERE attempt < $2
        AND ((status = 'pending' AND next_attempt_at <= $1) OR (status = 'sending' AND lease_until < $1))
      ORDER BY next_attempt_at LIMIT $3`,
    [now, MAX_DELIVERY_ATTEMPTS, limit],
  );
  return result.rows.map((row) => row.id);
}

// Section 6.4: the send times of deliveries in sending (the claim time) or sent, at or after
// `since`. The caller passes the earlier of the Berlin day's start and one hour ago.
export async function sendTimesSince(db: Queryable, since: Date): Promise<Date[]> {
  const result = await db.query<{ t: Date }>(
    `SELECT t FROM (
       SELECT CASE WHEN status = 'sent' THEN sent_at ELSE lease_until - $2::interval END AS t
         FROM app.alert_delivery WHERE status IN ('sending', 'sent')
     ) s WHERE t >= $1 ORDER BY t`,
    [since, `${SEND_LEASE_MS / 1000} seconds`],
  );
  return result.rows.map((row) => row.t);
}

// After EAUTH every send is held for 15 minutes (one row). A shorter pause never cuts a longer one.
export async function pauseSmtp(db: Queryable, until: Date): Promise<void> {
  await db.query(
    `INSERT INTO app.smtp_pause AS p (id, until) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET until = greatest(p.until, EXCLUDED.until)`,
    [until],
  );
}

// The end of the active pause, or null.
export async function smtpPausedUntil(db: Queryable, now: Date): Promise<Date | null> {
  const result = await db.query<{ until: Date }>("SELECT until FROM app.smtp_pause WHERE id = 1 AND until > $1", [now]);
  return result.rows[0]?.until ?? null;
}

export type DeliveryForSend = {
  id: string;
  alertId: string;
  recipient: string;
  status: DeliveryStatus;
  holdReason: HoldReason | null;
  attempt: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  // null once the message expired (purge) or before it was written.
  message: { subject: string; textBody: string; htmlBody: string } | null;
};

export async function getDeliveryForSend(db: Queryable, deliveryId: string): Promise<DeliveryForSend | null> {
  const result = await db.query<{
    id: string;
    alert_id: string;
    recipient: string;
    status: DeliveryStatus;
    hold_reason: HoldReason | null;
    attempt: number;
    next_attempt_at: Date;
    lease_until: Date | null;
    subject: string | null;
    text_body: string | null;
    html_body: string | null;
  }>(
    `SELECT d.id, d.alert_id, d.recipient, d.status, d.hold_reason, d.attempt, d.next_attempt_at, d.lease_until,
            m.subject, m.text_body, m.html_body
       FROM app.alert_delivery d LEFT JOIN ebay_live.alert_message m ON m.delivery_id = d.id
      WHERE d.id = $1`,
    [deliveryId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    alertId: row.alert_id,
    recipient: row.recipient,
    status: row.status,
    holdReason: row.hold_reason,
    attempt: row.attempt,
    nextAttemptAt: row.next_attempt_at,
    leaseUntil: row.lease_until,
    message:
      row.subject === null || row.text_body === null || row.html_body === null
        ? null
        : { subject: row.subject, textBody: row.text_body, htmlBody: row.html_body },
  };
}
