import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, signIn, type Harness } from "../../testing/harness.js";

// Spec 8.3 and auth.md 9: the account page lists the person's own sessions and signs out
// everywhere.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

// Made in the first test rather than in beforeAll, so a failure to build the app shows as that
// test's error.
const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

describe("GET /account", () => {
  it("lists the person's own open sessions with the IP as /24 and the browser, and offers Sign out everywhere", async () => {
    const hh = await harness();
    await addPerson(hh, "anna@example.test", "editor");
    await addPerson(hh, "ben@example.test", "editor");
    const laptop = hh.browser("198.51.100.7");
    await signIn(hh, laptop, "anna@example.test");
    const phone = hh.browser("203.0.113.9");
    await signIn(hh, phone, "anna@example.test");
    await signIn(hh, hh.browser("192.0.2.1"), "ben@example.test");

    const response = await laptop.get("/account");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Account - Just-Buy-It</title>");
    expect(html).toContain("anna@example.test");
    expect(html).toContain("198.51.100.0/24");
    expect(html).toContain("203.0.113.0/24");
    expect(html).not.toContain("192.0.2.0/24");
    expect(html).not.toContain("198.51.100.7");
    expect(html).toContain("This browser");
    expect(html).toContain('<form method="post" action="/account/sign-out-everywhere"');
    expect(html).toMatch(/<a href="\/account" aria-current="page"/);
  });
});

describe("POST /account/sign-out-everywhere", () => {
  it("ends every session of the person, this one too, and leaves other people's sessions alone", async () => {
    const hh = await harness();
    const laptop = hh.browser("198.51.100.7");
    await signIn(hh, laptop, "anna@example.test");
    const phone = hh.browser("203.0.113.9");
    await signIn(hh, phone, "anna@example.test");
    const ben = hh.browser("192.0.2.1");
    await signIn(hh, ben, "ben@example.test");
    const csrf = formToken(await (await laptop.get("/account")).text());

    const response = await laptop.post("/account/sign-out-everywhere", { _csrf: csrf });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.getSetCookie()).toEqual(["__Host-jbi_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"]);
    expect((await phone.get("/deals")).status).toBe(303);
    expect((await ben.get("/deals")).status).toBe(200);
    const events = await hh.db.admin.query("SELECT count(*)::int AS n FROM auth.auth_event WHERE event = 'sign_out_everywhere'");
    expect(events.rows[0]).toEqual({ n: 1 });
  });
});
