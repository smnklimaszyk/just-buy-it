import { describe, expect, it, vi } from "vitest";
import { SmtpError } from "./errors.js";
import { createLoginMailQueue, LOGIN_MAIL_TIMING, renderLoginMail, type QueuedMail } from "./login-mail.js";
import type { OutgoingEmail, SmtpMailer, SmtpSendResult } from "./smtp.js";

// 14:32 CEST.
const EXPIRES = new Date("2026-10-21T12:32:00.000Z");

describe("renderLoginMail", () => {
  it("names the code, the reference and the end of its 10 minutes, with no code in the subject and no link", () => {
    const mail = renderLoginMail({ code: "48210937", ref: "K7QF", expiresAt: EXPIRES });

    expect(mail.subject).toBe("Just-Buy-It sign-in code");
    expect(mail.text).toContain("4821 0937");
    expect(mail.text).toContain("Reference: K7QF");
    expect(mail.text).toContain("valid for 10 minutes, until 14:32 CEST");
    expect(mail.text).toContain("If you did not ask for this, ignore this mail. Nobody can sign in without the code.");
    expect(mail.html).toContain("4821 0937");
    expect(mail.html).toContain("K7QF");
    for (const part of [mail.subject, mail.text, mail.html]) expect(part).not.toMatch(/https?:|href=|www\./);
  });
});

// A mailer whose sends wait until the test settles them. Like createSmtpMailer, it stops waiting
// with a deadline error when the signal aborts.
function heldMailer() {
  const sends: { email: OutgoingEmail; signal: AbortSignal | undefined; settle: (outcome: "ok" | Error) => void }[] = [];
  const mailer: SmtpMailer = {
    send: (email, signal) =>
      new Promise<SmtpSendResult>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new SmtpError({ code: "deadline", responseCode: null })), { once: true });
        sends.push({
          email,
          signal,
          settle: (outcome) => (outcome === "ok" ? resolve({ messageId: "<m@test>", responseCode: 250 }) : reject(outcome)),
        });
      }),
    close: () => undefined,
  };
  return { mailer, sends };
}

const queued = (n: number): QueuedMail => ({
  id: `mail-${n}`,
  to: `person${n}@example.test`,
  mail: { subject: "Just-Buy-It sign-in code", text: "text", html: "<p>text</p>" },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLoginMailQueue", () => {
  it("sends at most two mails at once and starts the next when one is done", async () => {
    const { mailer, sends } = heldMailer();
    const queue = createLoginMailQueue({ mailer, onDropped: () => undefined });

    queue.push(queued(1));
    queue.push(queued(2));
    queue.push(queued(3));
    await tick();
    expect(sends.map((s) => s.email.to)).toEqual(["person1@example.test", "person2@example.test"]);

    sends[0]?.settle("ok");
    await tick();
    expect(sends.map((s) => s.email.to)).toEqual(["person1@example.test", "person2@example.test", "person3@example.test"]);
  });

  it("gives a send 10 s, tries a timed-out or 4xx send once more after 30 s, then drops it", async () => {
    const { mailer, sends } = heldMailer();
    const dropped: { id: string; code: string }[] = [];
    const queue = createLoginMailQueue({
      mailer,
      onDropped: (mail, error) => dropped.push({ id: mail.id, code: error.code }),
      // The second send is settled as soon as it starts, well inside its 200 ms, so a slow CI
      // runner cannot turn its 451 into a deadline.
      timing: { timeoutMs: 200, retryDelayMs: 30 },
    });
    expect(LOGIN_MAIL_TIMING).toEqual({ timeoutMs: 10_000, retryDelayMs: 30_000 });

    queue.push(queued(1));
    await tick();
    expect(sends).toHaveLength(1);
    await vi.waitFor(() => expect(sends[0]?.signal?.aborted).toBe(true), { timeout: 2_000, interval: 5 });
    expect(sends).toHaveLength(1);

    await vi.waitFor(() => expect(sends).toHaveLength(2), { timeout: 2_000, interval: 1 });
    sends[1]?.settle(new SmtpError({ code: "EENVELOPE", responseCode: 451 }));
    await tick();
    expect(dropped).toEqual([{ id: "mail-1", code: "EENVELOPE" }]);
  });

  it("drops a 5xx or login failure at once, and maps a raw nodemailer error", async () => {
    const { mailer, sends } = heldMailer();
    const dropped: { id: string; code: string }[] = [];
    const queue = createLoginMailQueue({
      mailer,
      onDropped: (mail, error) => dropped.push({ id: mail.id, code: error.code }),
      timing: { timeoutMs: 1_000, retryDelayMs: 10 },
    });

    queue.push(queued(1));
    queue.push(queued(2));
    await tick();
    sends[0]?.settle(new SmtpError({ code: "EENVELOPE", responseCode: 550 }));
    sends[1]?.settle(Object.assign(new Error("Invalid login: 535"), { code: "EAUTH", responseCode: 535 }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sends).toHaveLength(2);
    expect(dropped).toEqual([
      { id: "mail-1", code: "EENVELOPE" },
      { id: "mail-2", code: "EAUTH" },
    ]);
  });
});
