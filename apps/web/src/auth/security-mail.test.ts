import { createLoginMailQueue, createSmtpMailer } from "@ebay-sniper/notify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, LOGIN_SMTP, type Harness } from "../testing/harness.js";
import { createOutbox, createSecurityMail } from "./security-mail.js";

// Spec 7.9: security mail to all active admins and the person concerned, against Postgres 18.

let h: Harness;

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.db.drop();
});

beforeEach(async () => {
  await h.db.admin.query("TRUNCATE auth.auth_event, auth.rate_counter, auth.session, auth.login_attempt, auth.device, auth.app_user");
  h.smtp.sent.length = 0;
});

const securityMail = () =>
  createSecurityMail({
    pool: h.db.pool,
    queue: createLoginMailQueue({ mailer: createSmtpMailer(LOGIN_SMTP, h.smtp.createTransport), onDropped: () => undefined }),
    from: LOGIN_SMTP.from.address,
  });

describe("createSecurityMail", () => {
  it("mails the active admins and the person concerned in Bcc, from the noreply mailbox to itself", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    await addPerson(h, "second@example.test", "admin");
    await addPerson(h, "old@example.test", "admin", "disabled");
    await addPerson(h, "anna@example.test", "editor");

    await securityMail().send(
      { kind: "user_added", email: "anna@example.test", role: "editor" },
      { at: h.clock.now(), who: "info@intra-ai.de", ip: "198.51.100.7", concerned: ["anna@example.test", "info@intra-ai.de"] },
    );

    expect(h.smtp.sent).toHaveLength(1);
    expect(h.smtp.sent[0]).toMatchObject({
      to: "noreply@intra-ai.de",
      bcc: ["info@intra-ai.de", "second@example.test", "anna@example.test"],
      subject: "Just-Buy-It: anna@example.test was added as editor",
    });
    expect(String(h.smtp.sent[0]?.text)).toContain("IP: 198.51.100.0/24");
  });

  it("sends at most 30 a Berlin day (spec 7.5)", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    const mail = securityMail();
    for (let n = 0; n < 31; n += 1) {
      await mail.send({ kind: "user_disabled", email: `p${n}@example.test` }, { at: h.clock.now(), who: "the ops CLI on the server", ip: null, concerned: [] });
    }
    expect(h.smtp.sent).toHaveLength(30);
  });
});

describe("createOutbox", () => {
  it("records login_mail_failed with the attempt and the SMTP code when a sign-in mail fails for good", async () => {
    const outbox = createOutbox(h.deps, { mailer: createSmtpMailer(LOGIN_SMTP, h.smtp.createTransport), from: LOGIN_SMTP.from.address });
    h.smtp.reply(550);

    outbox.queue.push({ id: "0199f0c2-0000-7000-8000-000000000001", to: "anna@example.test", mail: { subject: "s", text: "t", html: "h" } });
    await vi.waitFor(async () => {
      const events = await h.db.admin.query("SELECT event, detail FROM auth.auth_event");
      expect(events.rows).toEqual([
        { event: "login_mail_failed", detail: { attempt_id: "0199f0c2-0000-7000-8000-000000000001", smtp_code: "EENVELOPE", response_code: 550 } },
      ]);
    });
  });
});
