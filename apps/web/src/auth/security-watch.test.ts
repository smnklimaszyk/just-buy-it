import { bootstrapAdmins, changeRole, disablePerson, recordAuditEvent, setCliCode, addPerson as storeAddPerson } from "@ebay-sniper/db";
import { createLoginMailQueue, createSmtpMailer } from "@ebay-sniper/notify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, LOGIN_SMTP, signIn, type Harness } from "../testing/harness.js";
import { createSecurityMail } from "./security-mail.js";
import { createSecurityWatch } from "./security-watch.js";

// Spec 7.9: web mails the admins on each security event, whether web, the ops CLI or the
// bootstrap wrote it. The watch reads the events from app.audit_event and auth.auth_event.

let h: Harness;

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.db.drop();
});

beforeEach(async () => {
  await h.db.admin.query(
    "TRUNCATE app.setting, app.audit_event, auth.auth_event, auth.rate_counter, auth.session, auth.login_attempt, auth.device, auth.app_user",
  );
  h.smtp.sent.length = 0;
});

// A watch that starts at the beginning of 2026 and takes events at once (no commit lag).
function watch(lagSeconds = 0) {
  const queue = createLoginMailQueue({ mailer: createSmtpMailer(LOGIN_SMTP, h.smtp.createTransport), onDropped: () => undefined });
  const security = createSecurityMail({ pool: h.db.pool, queue, from: LOGIN_SMTP.from.address });
  return createSecurityWatch({ pool: h.db.pool, security, lagSeconds }, new Date(Date.UTC(2026, 0, 1)));
}

const subjects = () => h.smtp.sent.map((mail) => mail.subject);

describe("createSecurityWatch", () => {
  it("mails a person added with `ops auth user add` to the admins and to that person, once", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    const security = watch();
    await storeAddPerson(h.db.pool, { email: "anna@example.test", role: "editor" }, { at: h.clock.now(), actor: "system:cli", userId: null });

    expect(await security.scan()).toBe(1);
    expect(await security.scan()).toBe(0);

    expect(subjects()).toEqual(["Just-Buy-It: anna@example.test was added as editor"]);
    expect(h.smtp.sent[0]?.bcc).toEqual(["info@intra-ai.de", "anna@example.test"]);
    expect(String(h.smtp.sent[0]?.text)).toContain("Who: the ops CLI on the server");
  });

  it("mails a role change made by an admin in web, naming that admin", async () => {
    const admin = await addPerson(h, "info@intra-ai.de", "admin");
    const anna = await addPerson(h, "anna@example.test", "editor");
    const security = watch();
    await changeRole(h.db.pool, { userId: anna, role: "admin" }, { at: h.clock.now(), actor: `user:${admin}`, userId: admin });

    expect(await security.scan()).toBe(1);

    expect(subjects()).toEqual(["Just-Buy-It: anna@example.test is now admin"]);
    expect(h.smtp.sent[0]?.bcc).toEqual(["anna@example.test", "info@intra-ai.de"]);
    expect(String(h.smtp.sent[0]?.text)).toContain("Who: info@intra-ai.de");
  });

  it("mails a disable to the admins and to the disabled person", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    const anna = await addPerson(h, "anna@example.test", "editor");
    const security = watch();
    await disablePerson(h.db.pool, { userId: anna }, { at: h.clock.now(), actor: "system:cli", userId: null });

    expect(await security.scan()).toBe(1);

    expect(subjects()).toEqual(["Just-Buy-It: anna@example.test was disabled"]);
    expect(h.smtp.sent[0]?.bcc).toEqual(["info@intra-ai.de", "anna@example.test"]);
  });

  it("mails the admin that `ops migrate` added from AUTH_BOOTSTRAP_ADMINS (owner decision 3)", async () => {
    const security = watch();
    const client = await h.db.admin.connect();
    try {
      await bootstrapAdmins(client, ["info@intra-ai.de"]);
    } finally {
      client.release();
    }

    expect(await security.scan()).toBe(1);

    expect(subjects()).toEqual(["Just-Buy-It: info@intra-ai.de was added as the first admin"]);
    expect(h.smtp.sent[0]?.bcc).toEqual(["info@intra-ai.de"]);
    expect(String(h.smtp.sent[0]?.text)).toContain("Who: ops migrate, from AUTH_BOOTSTRAP_ADMINS");
  });

  it("mails a recipients change only when it adds someone other than the editor, and tells those people", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    const editor = await addPerson(h, "editor@example.test", "editor");
    const anna = await addPerson(h, "anna@example.test", "editor");
    const security = watch();
    const change = (added: string[]) =>
      recordAuditEvent(h.db.pool, {
        at: h.clock.now(),
        actor: `user:${editor}`,
        action: "product.recipients_changed",
        detail: { key: "p_road_bike_56", version: 2, added, removed: [] },
      });
    await change([editor]);
    await change([editor, anna]);

    expect(await security.scan()).toBe(2);

    expect(subjects()).toEqual(["Just-Buy-It: anna@example.test now gets the alerts of p_road_bike_56"]);
    expect(h.smtp.sent[0]?.bcc).toEqual(["info@intra-ai.de", "anna@example.test"]);
    expect(String(h.smtp.sent[0]?.text)).toContain("Who: editor@example.test");
  });

  it("mails a code given out with `ops auth code`, with the IP /24 of the browser that asked", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    const browser = h.browser("198.51.100.77");
    const token = formToken(await (await browser.get("/login")).text());
    await browser.post("/login", { _csrf: token, email: "info@intra-ai.de" });
    await h.background.settled();
    h.smtp.sent.length = 0;
    const security = watch();
    const attempt = await h.db.admin.query<{ id: string }>("SELECT id FROM auth.login_attempt ORDER BY created_at DESC, id DESC LIMIT 1");
    await setCliCode(h.db.pool, { attemptId: attempt.rows[0]?.id ?? "", codeMac: "0".repeat(64), at: h.clock.now() });

    expect(await security.scan()).toBe(1);

    expect(subjects()).toEqual(["Just-Buy-It: a sign-in code for info@intra-ai.de was given out on the server"]);
    expect(h.smtp.sent[0]?.bcc).toEqual(["info@intra-ai.de"]);
    expect(String(h.smtp.sent[0]?.text)).toContain("IP: 198.51.100.0/24");
  });

  it("mails a sign-in from a browser without a device cookie, and not one from a known browser", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    await addPerson(h, "anna@example.test", "editor");
    const browser = h.browser("203.0.113.40");
    await signIn(h, browser, "anna@example.test");
    await signIn(h, browser, "anna@example.test");
    h.smtp.sent.length = 0;

    expect(await watch().scan()).toBe(1);

    expect(subjects()).toEqual(["Just-Buy-It: anna@example.test signed in from a new browser"]);
    expect(h.smtp.sent[0]?.bcc).toEqual(["info@intra-ai.de", "anna@example.test"]);
    expect(String(h.smtp.sent[0]?.text)).toContain("Who: anna@example.test");
    expect(String(h.smtp.sent[0]?.text)).toContain("IP: 203.0.113.0/24");
  });

  it("leaves an event younger than the lag for a later scan, so a transaction that commits late is not skipped", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    const security = watch(3_600);
    await storeAddPerson(h.db.pool, { email: "anna@example.test", role: "editor" }, { at: h.clock.now(), actor: "system:cli", userId: null });

    expect(await security.scan()).toBe(0);
    expect(h.smtp.sent).toEqual([]);
  });

  it("starts after a restart where the last watch stopped, so no event is mailed twice", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    await storeAddPerson(h.db.pool, { email: "anna@example.test", role: "editor" }, { at: h.clock.now(), actor: "system:cli", userId: null });
    await signIn(h, h.browser("198.51.100.90"), "info@intra-ai.de");
    expect(await watch().scan(), "events of the first watch").toBe(2);
    h.smtp.sent.length = 0;

    expect(await watch().scan(), "events of the watch after the restart").toBe(0);
    expect(subjects()).toEqual([]);
  });

  it("keeps the position after a scan that found only sign-in events", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    await signIn(h, h.browser("198.51.100.91"), "info@intra-ai.de");
    expect(await watch().scan(), "events of the first watch").toBe(1);

    expect(await watch().scan(), "events of the watch after the restart").toBe(0);
  });
});
