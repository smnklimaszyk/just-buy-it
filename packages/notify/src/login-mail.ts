import { formatBerlinTime } from "@ebay-sniper/domain";
import { SmtpError, toSmtpError } from "./errors.js";
import type { SmtpMailer } from "./smtp.js";

// Spec 7.9, ADR 0038: the sign-in mail web sends from the noreply mailbox. The code is not in the
// subject, so it does not show on a lock screen, and there is no link: mail scanners open links.

export type LoginMailInput = {
  // 8 digits.
  code: string;
  // The 4 characters the code page shows.
  ref: string;
  expiresAt: Date;
};

export type LoginMail = { subject: string; text: string; html: string };

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

// "4821 0937": easier to read off and type; the code page takes it with or without the space.
const grouped = (code: string): string => `${code.slice(0, 4)} ${code.slice(4)}`;

// One sign-in or security mail. The id becomes the X-Delivery-Id header.
export type QueuedMail = { id: string; to: string; bcc?: readonly string[]; mail: LoginMail };

export type LoginMailQueue = { push(mail: QueuedMail): void };

export type LoginMailTiming = { timeoutMs: number; retryDelayMs: number };

// Spec 7.9: 10 s per send, one more try 30 s after a timeout or a 4xx reply.
export const LOGIN_MAIL_TIMING: LoginMailTiming = { timeoutMs: 10_000, retryDelayMs: 30_000 };

export type LoginMailQueueDeps = {
  mailer: SmtpMailer;
  // After the last try; web records login_mail_failed. The person simply asks again.
  onDropped: (mail: QueuedMail, error: SmtpError) => void;
  timing?: LoginMailTiming;
};

// Spec 7.9: web sends after the reply, from memory, so the code never sits in a job or a row.
// At most 2 sends at once; a mail waiting for its second try holds no slot.
const CONCURRENCY = 2;

type Job = { queued: QueuedMail; attempt: 1 | 2 };

export function createLoginMailQueue(deps: LoginMailQueueDeps): LoginMailQueue {
  const timing = deps.timing ?? LOGIN_MAIL_TIMING;
  const waiting: Job[] = [];
  let active = 0;

  const send = async ({ queued, attempt }: Job): Promise<void> => {
    try {
      await deps.mailer.send(
        { deliveryId: queued.id, to: queued.to, ...(queued.bcc === undefined ? {} : { bcc: queued.bcc }), ...queued.mail },
        AbortSignal.timeout(timing.timeoutMs),
      );
    } catch (error) {
      const failure = error instanceof SmtpError ? error : toSmtpError(error);
      if (attempt === 1 && failure.kind === "transient") {
        setTimeout(() => enqueue({ queued, attempt: 2 }), timing.retryDelayMs).unref();
        return;
      }
      deps.onDropped(queued, failure);
    }
  };

  const next = (): void => {
    while (active < CONCURRENCY) {
      const job = waiting.shift();
      if (job === undefined) return;
      active += 1;
      void send(job).finally(() => {
        active -= 1;
        next();
      });
    }
  };

  const enqueue = (job: Job): void => {
    waiting.push(job);
    next();
  };

  return { push: (queued) => enqueue({ queued, attempt: 1 }) };
}

export function renderLoginMail(input: LoginMailInput): LoginMail {
  const lines = [
    `Your Just-Buy-It sign-in code: ${grouped(input.code)}`,
    `Reference: ${input.ref} (the sign-in page shows the same reference)`,
    `The code is valid for 10 minutes, until ${formatBerlinTime(input.expiresAt)}.`,
    "If you did not ask for this, ignore this mail. Nobody can sign in without the code.",
  ];
  return {
    subject: "Just-Buy-It sign-in code",
    text: `${lines.join("\n\n")}\n`,
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
  };
}
