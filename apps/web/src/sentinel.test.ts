import { createSmtpMailer } from "@ebay-sniper/notify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createOutbox } from "./auth/security-mail.js";
import { createSecurityWatch } from "./auth/security-watch.js";
import { LOGIN_SMTP_TEST_PASSWORD } from "./testing/fakes.js";
import { addPerson, createHarness, formToken, LOGIN_SMTP, TEST_AUTH_KEY, type Harness } from "./testing/harness.js";

// Spec 7.9 and auth.md 15, as ADR 0035's sentinel: the sign-in code, the session, device and
// login cookies, AUTH_KEY, the mailbox password and full addresses go through a whole sign-in,
// including SMTP login failures whose errors carry the password. None of them may reach a log
// line. (packages/logging redacts the same field names as a second guard.)

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

afterAll(async () => {
  await h?.db.drop();
});

const OWNER = "sentinel-owner-7c41@example.test";

describe("sentinel", () => {
  it("logs no code, token, cookie, key, mailbox password or address during sign-in, mail failures and sign-out", async () => {
    h = await createHarness();
    const hh = h;
    await addPerson(hh, OWNER, "admin");
    const browser = hh.browser("198.51.100.7");

    // Sign in, with one wrong code first.
    const token = formToken(await (await browser.get("/login")).text());
    await browser.post("/login", { _csrf: token, email: OWNER });
    await hh.background.settled();
    const mail = String(hh.smtp.sent.at(-1)?.text);
    const code = /sign-in code: (\d{4}) (\d{4})/.exec(mail)?.slice(1, 3).join("") ?? "";
    const codeToken = formToken(await (await browser.get("/login/code")).text());
    const loginCookie = browser.cookies.get("__Host-jbi_login") ?? "";
    await browser.post("/login/code", { _csrf: codeToken, code: code === "00000000" ? "11111111" : "00000000" });
    await browser.post("/login/code", { _csrf: codeToken, code });
    const session = browser.cookies.get("__Host-jbi_session") ?? "";
    const device = browser.cookies.get("__Host-jbi_device") ?? "";

    // A sign-in mail and a security mail that fail with a 535 whose error carries the password.
    hh.smtp.reply("auth", "auth");
    const second = hh.browser("203.0.113.9");
    await second.post("/login", { _csrf: formToken(await (await second.get("/login")).text()), email: OWNER });
    await hh.background.settled();
    const outbox = createOutbox(hh.deps, { mailer: createSmtpMailer(LOGIN_SMTP, hh.smtp.createTransport), from: LOGIN_SMTP.from.address });
    await createSecurityWatch({ ...hh.deps, security: outbox.security, lagSeconds: 0 }, new Date(Date.UTC(2026, 0, 1))).scan();
    await vi.waitFor(() => expect(hh.testLog.events("security_mail_failed").length).toBeGreaterThan(0));

    // Sign out.
    await browser.post("/logout", { _csrf: formToken(await (await browser.get("/deals")).text()) });

    const plain = Buffer.from(`\0${LOGIN_SMTP.user}\0${LOGIN_SMTP_TEST_PASSWORD}`).toString("base64");
    const secrets = [code, session, device, loginCookie, TEST_AUTH_KEY.toString("base64"), LOGIN_SMTP_TEST_PASSWORD, plain, OWNER];
    expect(secrets.every((secret) => secret.length >= 8)).toBe(true);

    expect(hh.testLog.events("security_mail_failed")).toEqual([{ event: "security_mail_failed", smtp_code: "EAUTH", response_code: 535 }]);
    const logged = hh.testLog.text();
    for (const secret of secrets) expect(logged).not.toContain(secret);
  });
});
