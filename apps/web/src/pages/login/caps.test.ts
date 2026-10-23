import { startOfBerlinDay } from "@ebay-sniper/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, type Harness } from "../../testing/harness.js";

// Spec 7.5 and auth.md 15: the sign-in mail caps, against Postgres 18 and a fake SMTP server.

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

const mailsTo = (email: string) => h.smtp.sent.filter((mail) => mail.to === email).length;

// One code request from its own browser and IP, so only the address caps count.
async function askForCode(email: string, n: number): Promise<number> {
  const browser = h.browser(`198.51.100.${n}`);
  const token = formToken(await (await browser.get("/login")).text());
  const reply = await browser.post("/login", { _csrf: token, email });
  await h.background.settled();
  return reply.status;
}

describe("sign-in mail caps", () => {
  it("sends nothing for the 6th code request for one address within an hour, with the same reply", async () => {
    await addPerson(h, "anna@example.test", "editor");
    const replies = [];
    for (let n = 1; n <= 6; n += 1) replies.push(await askForCode("anna@example.test", n));

    expect(replies).toEqual([303, 303, 303, 303, 303, 303]);
    expect(mailsTo("anna@example.test")).toBe(5);
  });

  it("counts the addresses of one IPv6 /64 as one client for the 5 code requests in 15 minutes", async () => {
    for (let n = 1; n <= 6; n += 1) {
      const browser = h.browser(`2001:db8:5:6::${n}`);
      const token = formToken(await (await browser.get("/login")).text());
      await browser.post("/login", { _csrf: token, email: `person${n}@example.test` });
    }

    const attempts = await h.db.admin.query("SELECT count(*)::int AS n FROM auth.login_attempt");
    expect(attempts.rows[0], "attempts written for 6 requests from one /64").toEqual({ n: 5 });
  });

  it("does not send the 61st sign-in mail of the Berlin day, and tells the admins once", async () => {
    await addPerson(h, "info@intra-ai.de", "admin");
    await addPerson(h, "anna@example.test", "editor");
    await h.db.admin.query("INSERT INTO auth.rate_counter (key, window_start, count) VALUES ('login_mails_day:all', $1, 60)", [
      startOfBerlinDay(h.clock.now()),
    ]);

    await askForCode("anna@example.test", 1);
    await askForCode("anna@example.test", 2);

    expect(mailsTo("anna@example.test")).toBe(0);
    const told = h.smtp.sent.filter((mail) => mail.subject === "Just-Buy-It: the daily limit of sign-in mails is reached");
    expect(told).toHaveLength(1);
    expect(told[0]?.bcc).toEqual(["info@intra-ai.de"]);
  });
});
