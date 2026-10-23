import { randomUUID } from "node:crypto";
import { listPeople, recordAuthEvent, takeRateSlot, type DbPool } from "@ebay-sniper/db";
import type { Clock } from "@ebay-sniper/domain";
import { createLoginMailQueue, renderSecurityMail, type LoginMailQueue, type SecurityEvent, type SmtpMailer } from "@ebay-sniper/notify";
import type { Log } from "../background.js";
import { shortIp } from "./ip.js";

// Spec 7.9: the mail to all active admins, and to the person concerned, when something changes
// who can sign in or who gets alerts. Sent from the noreply mailbox to itself with everyone in
// Bcc, so no recipient sees another's address.

export type SecurityMailInput = {
  at: Date;
  // The person who did it, or a description such as "the ops CLI on the server".
  who: string;
  ip: string | null;
  // Addresses beyond the active admins: the person added, disabled or re-roled.
  concerned: readonly string[];
};

export type SecurityMail = { send(event: SecurityEvent, input: SecurityMailInput): Promise<void> };

export type Outbox = { queue: LoginMailQueue; security: SecurityMail };

const SECURITY_ID = "security:";

// The noreply mailbox's send queue with the security mail on top (spec 7.9). A sign-in mail that
// fails for good becomes login_mail_failed; the person simply asks again.
export function createOutbox(deps: { pool: DbPool; clock: Clock; log: Log }, mail: { mailer: SmtpMailer; from: string }): Outbox {
  const queue = createLoginMailQueue({
    mailer: mail.mailer,
    onDropped: (dropped, error) => {
      const smtp = { smtp_code: error.code, response_code: error.responseCode };
      if (dropped.id.startsWith(SECURITY_ID)) {
        deps.log.warn({ event: "security_mail_failed", ...smtp });
        return;
      }
      void recordAuthEvent(deps.pool, { at: deps.clock.now(), event: "login_mail_failed", detail: { attempt_id: dropped.id, ...smtp } }).catch(
        (failure: unknown) => deps.log.error({ event: "login_mail_failed_not_recorded", err_name: failure instanceof Error ? failure.name : "unknown" }),
      );
    },
  });
  return { queue, security: createSecurityMail({ pool: deps.pool, queue, from: mail.from }) };
}

export function createSecurityMail(deps: { pool: DbPool; queue: LoginMailQueue; from: string }): SecurityMail {
  return {
    async send(event, input) {
      // At most 30 a Berlin day (spec 7.5), so a flood of changes cannot flood the mailboxes.
      if (!(await takeRateSlot(deps.pool, "security_mails_day", "all", input.at))) return;
      const admins = (await listPeople(deps.pool)).filter((person) => person.role === "admin" && person.status === "active");
      const recipients = [...new Set([...admins.map((person) => person.email), ...input.concerned])];
      deps.queue.push({
        id: `${SECURITY_ID}${randomUUID()}`,
        to: deps.from,
        bcc: recipients,
        mail: renderSecurityMail({ event, who: input.who, at: input.at, ip24: shortIp(input.ip) }),
      });
    },
  };
}
