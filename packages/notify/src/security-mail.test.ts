import { describe, expect, it } from "vitest";
import { renderSecurityMail, type SecurityEvent } from "./security-mail.js";

// 14:05 CEST.
const AT = new Date("2026-10-21T12:05:00.000Z");

describe("renderSecurityMail", () => {
  it("says what happened in the subject, and who, when and the IP /24 in the body", () => {
    const mail = renderSecurityMail({
      event: { kind: "user_added", email: "anna@example.test", role: "editor" },
      who: "info@intra-ai.de",
      at: AT,
      ip24: "198.51.100.0/24",
    });

    expect(mail.subject).toBe("Just-Buy-It: anna@example.test was added as editor");
    expect(mail.text).toContain("Who: info@intra-ai.de");
    expect(mail.text).toContain("When: 14:05 CEST on 2026-10-21");
    expect(mail.text).toContain("IP: 198.51.100.0/24");
    expect(mail.html).toContain("anna@example.test was added as editor");
  });

  it("has a subject for every event of spec 7.9 and the two sign-in limits", () => {
    const events: [SecurityEvent, string][] = [
      [{ kind: "user_added", email: "a@example.test", role: "admin" }, "a@example.test was added as admin"],
      [{ kind: "user_role_changed", email: "a@example.test", role: "editor" }, "a@example.test is now editor"],
      [{ kind: "user_disabled", email: "a@example.test" }, "a@example.test was disabled"],
      [{ kind: "bootstrap_admin_added", email: "a@example.test" }, "a@example.test was added as the first admin"],
      [{ kind: "login_code_cli", email: "a@example.test", ref: "K7QF" }, "a sign-in code for a@example.test was given out on the server"],
      [{ kind: "recipients_changed", product: "Road bike 56 cm", added: ["b@example.test"] }, "b@example.test now gets the alerts of Road bike 56 cm"],
      [{ kind: "new_device_sign_in", email: "a@example.test" }, "a@example.test signed in from a new browser"],
      [{ kind: "sign_in_locked", email: "a@example.test" }, "sign-in for a@example.test is locked for new browsers"],
      [{ kind: "login_mail_cap" }, "the daily limit of sign-in mails is reached"],
    ];
    for (const [event, subject] of events) {
      expect(renderSecurityMail({ event, who: "the ops CLI on the server", at: AT, ip24: null }).subject).toBe(`Just-Buy-It: ${subject}`);
    }
  });

  it("keeps a product name with line breaks and markup on one escaped line", () => {
    const mail = renderSecurityMail({
      event: { kind: "recipients_changed", product: "Bike\r\nBcc: x@evil.test‮ <b>", added: ["b@example.test"] },
      who: "info@intra-ai.de",
      at: AT,
      ip24: null,
    });

    expect(mail.subject).toBe("Just-Buy-It: b@example.test now gets the alerts of Bike Bcc: x@evil.test <b>");
    expect(mail.html).not.toContain("<b>");
    expect(mail.html).toContain("&lt;b&gt;");
    expect(mail.text).toContain("IP: not recorded");
  });
});
