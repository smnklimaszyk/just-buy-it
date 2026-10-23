import { findAttemptForCli, setCliCode } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "../../auth/keys.js";
import { addPerson, createHarness, formToken, signIn, TEST_AUTH_KEY, type Browser, type Harness } from "../../testing/harness.js";

// Spec 7.5: a stranger who knows the owner's address can block new browsers for a day, but not
// the owner's own browser with its device cookie, and never `ops auth code`.

let h: Harness;
let owner: Browser;

const OWNER = "info@intra-ai.de";

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  h = await createHarness();
  await addPerson(h, OWNER, "admin");
  owner = h.browser("198.51.100.7");
  // The owner's browser signed in once before, so it holds a device cookie.
  await signIn(h, owner, OWNER);
}, 60_000);

afterAll(async () => {
  await h.db.drop();
});

const mailsTo = (email: string) => h.smtp.sent.filter((mail) => mail.to === email).length;

// One code request and its three wrong tries, from the stranger's browser.
async function guessThreeTimes(stranger: Browser): Promise<void> {
  const token = formToken(await (await stranger.get("/login")).text());
  await stranger.post("/login", { _csrf: token, email: OWNER });
  const codeToken = formToken(await (await stranger.get("/login/code")).text());
  for (const wrong of ["00000001", "00000002", "00000003"]) await stranger.post("/login/code", { _csrf: codeToken, code: wrong });
}

describe("lockout (spec 7.5)", () => {
  it("lets the owner's browser with its device cookie get a code and sign in after 4 requests and 12 wrong tries from one IP", async () => {
    const stranger = h.browser("203.0.113.9");
    for (let i = 0; i < 4; i += 1) await guessThreeTimes(stranger);
    await h.background.settled();
    const mailsBefore = mailsTo(OWNER);

    await signIn(h, owner, OWNER);

    expect(mailsTo(OWNER)).toBe(mailsBefore + 1);
    expect((await owner.get("/deals")).status).toBe(200);
  });

  it("keeps a browser's device cookie across sign-ins, so it still counts the next time", async () => {
    await addPerson(h, "anna@example.test", "editor");
    const browser = h.browser("198.51.100.20");
    await signIn(h, browser, "anna@example.test");
    const device = browser.cookies.get("__Host-jbi_device");

    await signIn(h, browser, "anna@example.test");

    expect(browser.cookies.get("__Host-jbi_device")).toBe(device);
  });

  it("replaces a device cookie the database does not know, so the next sign-in counts the browser as known", async () => {
    await addPerson(h, "ben@example.test", "editor");
    const browser = h.browser("198.51.100.21");
    browser.cookies.set("__Host-jbi_device", "made-up-or-revoked");
    const newDevice = async () => {
      const events = await h.db.admin.query<{ new_device: boolean }>(
        `SELECT (e.detail->>'new_device')::boolean AS new_device FROM auth.auth_event e JOIN auth.app_user u ON u.id = e.user_id
         WHERE u.email = 'ben@example.test' AND e.event = 'login_succeeded' ORDER BY e.id DESC LIMIT 1`,
      );
      return events.rows[0]?.new_device;
    };

    await signIn(h, browser, "ben@example.test");
    expect(browser.cookies.get("__Host-jbi_device")).not.toBe("made-up-or-revoked");
    expect(await newDevice()).toBe(true);

    await signIn(h, browser, "ben@example.test");
    expect(await newDevice()).toBe(false);
  });

  it("sends no code to a browser without a device cookie while the address is locked, with the same reply", async () => {
    const newBrowser = h.browser("198.51.100.99");
    const mailsBefore = mailsTo(OWNER);

    const token = formToken(await (await newBrowser.get("/login")).text());
    const reply = await newBrowser.post("/login", { _csrf: token, email: OWNER });
    await h.background.settled();

    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/login/code");
    expect(mailsTo(OWNER)).toBe(mailsBefore);
  });

  it("still signs in the locked address with a code from `ops auth code --ref`", async () => {
    const newBrowser = h.browser("198.51.100.98");
    const token = formToken(await (await newBrowser.get("/login")).text());
    await newBrowser.post("/login", { _csrf: token, email: OWNER });
    const codePage = await (await newBrowser.get("/login/code")).text();
    const ref = /Reference ([A-Z0-9]{4})/.exec(codePage)?.[1] ?? "";

    // What apps/ops/src/auth-command.ts does with the reference the person reads out.
    const keys = createAuthKeys(TEST_AUTH_KEY);
    const attempt = await findAttemptForCli(h.db.pool, { emailMac: keys.emailMac(OWNER), ref, at: h.clock.now() });
    if (attempt === null) throw new Error("no attempt for the reference");
    expect(await setCliCode(h.db.pool, { attemptId: attempt.id, codeMac: keys.codeMac(attempt.id, "13572468"), at: h.clock.now() })).toBe(true);

    const response = await newBrowser.post("/login/code", { _csrf: formToken(codePage), code: "1357 2468" });
    expect(response.headers.get("location")).toBe("/");
  });

  it("told the admins once, not on every refused request, that new browsers get no code for the address", async () => {
    await h.background.settled();
    const told = h.smtp.sent.filter((mail) => mail.subject === `Just-Buy-It: sign-in for ${OWNER} is locked for new browsers`);
    expect(told).toHaveLength(1);
    expect(told[0]?.bcc).toEqual([OWNER]);
  });
});
