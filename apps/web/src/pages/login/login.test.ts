import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tokenHash } from "../../auth/tokens.js";
import { createHarness, formToken, type Browser, type Harness } from "../../testing/harness.js";

// Spec 7.2 and auth.md 15: the sign-in pages against Postgres 18 and a fake SMTP server.

let h: Harness;

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.db.drop();
});

describe("GET /login", () => {
  it("shows the address form with a form token tied to a new __Host-jbi_login cookie", async () => {
    const browser = h.browser();
    const response = await browser.get("/login");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('autocomplete="email"');
    expect(formToken(html)).toMatch(/^[0-9a-f]{64}$/);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/^__Host-jbi_login=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  });
});

async function addPerson(email: string, role: "admin" | "editor", status: "active" | "disabled" = "active"): Promise<void> {
  await h.db.admin.query(
    `INSERT INTO auth.app_user (email, role, status, created_at, disabled_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'disabled' THEN $4::timestamptz END)`,
    [email, role, status, h.clock.now()],
  );
}

// GET /login, then POST /login with the page's token.
async function askForCode(browser: Browser, email: string): Promise<Response> {
  const token = formToken(await (await browser.get("/login")).text());
  return browser.post("/login", { _csrf: token, email });
}

describe("GET /login layout (spec 8.3)", () => {
  it("names the product in a heading above a narrow centred form", async () => {
    const html = await (await h.browser().get("/login")).text();

    expect(html).toContain('<main id="main" class="app-page app-narrow">');
    expect(html).toContain('<h1 class="type-title-lg">Sign in to Just-Buy-It</h1>');
  });

  it("uses the theme the browser chose, from its theme cookie", async () => {
    const html = await (await h.browser().get("/login", { Cookie: "__Host-jbi_theme=dark" })).text();

    expect(html).toContain('<html lang="en" data-theme="dark">');
  });
});

describe("POST /login", () => {
  it("answers an unknown, a disabled and an active address the same, mails only the active one, and does not wait for SMTP", async () => {
    await addPerson("info@intra-ai.de", "admin");
    await addPerson("gone@example.test", "editor", "disabled");
    // The one mail this test sends never gets an answer.
    h.smtp.reply("hang");

    const replies = [];
    for (const [i, email] of ["stranger@example.test", "gone@example.test", "info@intra-ai.de"].entries()) {
      const reply = await Promise.race([
        askForCode(h.browser(`198.51.100.${i + 1}`), email),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("POST /login waited for SMTP")), 2_000)),
      ]);
      replies.push({
        status: reply.status,
        location: reply.headers.get("location"),
        body: await reply.text(),
        cookie: reply.headers.getSetCookie().map((line) => line.replace(/=[^;]+/, "=…")),
      });
    }
    await h.background.settled();

    expect(replies[0]).toEqual({
      status: 303,
      location: "/login/code",
      body: "",
      cookie: ["__Host-jbi_login=…; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Strict"],
    });
    expect(replies[1]).toEqual(replies[0]);
    expect(replies[2]).toEqual(replies[0]);
    expect(h.smtp.sent.map((mail) => mail.to)).toEqual(["info@intra-ai.de"]);
    const attempts = await h.db.admin.query("SELECT count(*)::int AS n FROM auth.login_attempt");
    expect(attempts.rows[0]).toEqual({ n: 3 });
  });
});

describe("POST /login refusals", () => {
  it("sends a post without the login cookie or with a wrong form token back to /login, and starts no attempt", async () => {
    const before = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM auth.login_attempt");
    const noCookie = await h.browser("198.51.100.60").post("/login", { _csrf: "x".repeat(64), email: "info@intra-ai.de" });
    const browser = h.browser("198.51.100.61");
    await browser.get("/login");
    const wrongToken = await browser.post("/login", { _csrf: "x".repeat(64), email: "info@intra-ai.de" });

    for (const reply of [noCookie, wrongToken]) {
      expect(reply.status).toBe(303);
      expect(reply.headers.get("location")).toBe("/login");
    }
    const after = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM auth.login_attempt");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("shows the form again with a field error for something that is not one email address", async () => {
    const browser = h.browser("198.51.100.62");
    const token = formToken(await (await browser.get("/login")).text());

    const reply = await browser.post("/login", { _csrf: token, email: "not an address" });

    expect(reply.status).toBe(400);
    const html = await reply.text();
    expect(html).toContain("Enter one email address, like name@example.com.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('value="not an address"');
    expect(formToken(html)).toBe(token);
  });
});

describe("GET /login/code", () => {
  it("shows the 8-cell code field, the reply text and the attempt's reference", async () => {
    const browser = h.browser("198.51.100.20");
    await askForCode(browser, "stranger@example.test");
    const attempt = await h.db.admin.query<{ ref: string }>("SELECT ref FROM auth.login_attempt ORDER BY created_at DESC, id DESC LIMIT 1");
    const ref = attempt.rows[0]?.ref ?? "";

    const response = await browser.get("/login/code");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html.match(/class="ia-otp__cell/g)).toHaveLength(8);
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain("If this address is approved, a code is on its way. It is valid for 10 minutes.");
    expect(html).toContain(`Reference ${ref}`);
    expect(formToken(html)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a heading in the narrow column and a way back to change the address or ask for a new code", async () => {
    const browser = h.browser("198.51.100.21");
    await askForCode(browser, "stranger@example.test");

    const html = await (await browser.get("/login/code")).text();

    expect(html).toContain('<main id="main" class="app-page app-narrow">');
    expect(html).toContain('<h1 class="type-title-lg">Enter your code</h1>');
    expect(html).toMatch(/<a href="\/login" class="ia-btn [^"]*ia-btn--secondary[^"]*"[^>]*><span class="ia-btn__label">Use another address<\/span><\/a>/);
  });
});

// The code of the newest sign-in mail to that address.
function mailedCode(email: string): string {
  const mail = h.smtp.sent.filter((sent) => sent.to === email).at(-1);
  const match = /sign-in code: (\d{4}) (\d{4})/.exec(String(mail?.text));
  if (match === null) throw new Error(`no sign-in mail to ${email}`);
  return `${match[1]}${match[2]}`;
}

// The code page's form, posted with the code in its 8 cells.
async function enterCode(browser: Browser, code: string): Promise<Response> {
  const token = formToken(await (await browser.get("/login/code")).text());
  return browser.post("/login/code", { _csrf: token, code: [...code] });
}

describe("POST /login/code", () => {
  it("signs in with the mailed code: new session and device cookies, login cookie gone, 303 to /", async () => {
    await addPerson("anna@example.test", "editor");
    const browser = h.browser("198.51.100.30");
    await askForCode(browser, "anna@example.test");
    await h.background.settled();

    const response = await enterCode(browser, mailedCode("anna@example.test"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const cookies = response.headers.getSetCookie().map((line) => line.replace(/^([^=]+)=[^;]*/, "$1=…"));
    expect(cookies.sort()).toEqual(
      [
        "__Host-jbi_session=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax",
        "__Host-jbi_device=…; Max-Age=15552000; Path=/; HttpOnly; Secure; SameSite=Lax",
        "__Host-jbi_login=…; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
      ].sort(),
    );
    const sessions = await h.db.admin.query("SELECT count(*)::int AS n FROM auth.session WHERE ended_at IS NULL");
    expect(sessions.rows[0]).toEqual({ n: 1 });
  });

  it("refuses the right code with a wrong form token, without using a try (spec 7.2)", async () => {
    await addPerson("eva@example.test", "editor");
    const browser = h.browser("198.51.100.35");
    await askForCode(browser, "eva@example.test");
    await h.background.settled();
    const code = mailedCode("eva@example.test");

    const forged = await browser.post("/login/code", { _csrf: "x".repeat(64), code: [...code] });

    expect(forged.status, "status with a wrong form token").toBe(200);
    expect(await forged.text()).toContain("That code did not work. Check the newest mail or ask for a new code.");
    const tries = await h.db.admin.query("SELECT failed_tries FROM auth.login_attempt WHERE ip = '198.51.100.35'");
    expect(tries.rows, "tries used by the refused post").toEqual([{ failed_tries: 0 }]);
    expect((await enterCode(browser, code)).headers.get("location"), "the same code with the page's token").toBe("/");
  });

  it("answers a wrong code with the one failure message on the code page, and signs nobody in", async () => {
    await addPerson("ben@example.test", "editor");
    const browser = h.browser("198.51.100.31");
    await askForCode(browser, "ben@example.test");
    await h.background.settled();
    const wrong = mailedCode("ben@example.test") === "11111111" ? "22222222" : "11111111";

    const response = await enterCode(browser, wrong);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("That code did not work. Check the newest mail or ask for a new code.");
    expect(html.match(/class="ia-otp__cell[^"]*is-invalid/g)).toHaveLength(8);
    expect(response.headers.getSetCookie()).toEqual([]);
    const sessions = await h.db.admin.query(
      "SELECT count(*)::int AS n FROM auth.session s JOIN auth.app_user u ON u.id = s.user_id WHERE u.email = 'ben@example.test'",
    );
    expect(sessions.rows[0]).toEqual({ n: 0 });
  });

  it("takes a code once, only in the browser that asked, at most 3 tries, and not after 10 minutes (auth.md 15)", async () => {
    await addPerson("cleo@example.test", "editor");
    const signedIn = (response: Response) => response.status === 303 && response.headers.get("location") === "/";
    const fresh = async (ip: string) => {
      const browser = h.browser(ip);
      await askForCode(browser, "cleo@example.test");
      await h.background.settled();
      return { browser, code: mailedCode("cleo@example.test") };
    };

    const post = async (browser: Browser, token: string, code: string) => signedIn(await browser.post("/login/code", { _csrf: token, code }));
    const codePageToken = async (browser: Browser) => formToken(await (await browser.get("/login/code")).text());

    // Once.
    const a = await fresh("198.51.100.40");
    const aToken = await codePageToken(a.browser);
    expect(await post(a.browser, aToken, a.code)).toBe(true);
    expect(await post(a.browser, aToken, a.code)).toBe(false);

    // Another browser has its own login cookie, so B's code is not for it.
    const b = await fresh("198.51.100.41");
    const other = h.browser("198.51.100.42");
    const otherToken = formToken(await (await other.get("/login")).text());
    expect(await post(other, otherToken, b.code)).toBe(false);
    expect(await post(b.browser, await codePageToken(b.browser), b.code)).toBe(true);

    // The right code as the 4th try.
    const c = await fresh("198.51.100.43");
    const cToken = await codePageToken(c.browser);
    for (const wrong of ["00000001", "00000002", "00000003"]) await post(c.browser, cToken, wrong === c.code ? "00000004" : wrong);
    expect(await post(c.browser, cToken, c.code)).toBe(false);

    // 10 minutes and 1 second later.
    const d = await fresh("198.51.100.44");
    const dToken = await codePageToken(d.browser);
    h.clock.advance(10 * 60_000 + 1_000);
    expect(await post(d.browser, dToken, d.code)).toBe(false);
  });

  it("gives a new session token on every sign-in and ends the session the browser came with (spec 7.4)", async () => {
    await addPerson("dora@example.test", "editor");
    const browser = h.browser("198.51.100.50");
    const signInOnce = async () => {
      await askForCode(browser, "dora@example.test");
      await h.background.settled();
      await enterCode(browser, mailedCode("dora@example.test"));
      return browser.cookies.get("__Host-jbi_session") ?? "";
    };

    const first = await signInOnce();
    const second = await signInOnce();

    expect(second).not.toBe(first);
    const rows = await h.db.admin.query<{ token_hash: string; end_reason: string | null }>(
      "SELECT token_hash, end_reason FROM auth.session WHERE token_hash IN ($1, $2)",
      [tokenHash(first), tokenHash(second)],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.token_hash, row.end_reason]))).toEqual({
      [tokenHash(first)]: "replaced",
      [tokenHash(second)]: null,
    });
  });
});

describe("GET /login again", () => {
  // A browser fetches /favicon.ico on its own; the guard sends that request to /login. The form
  // the person has open must still work afterwards.
  it("keeps the form token of an open page when the same browser loads /login again", async () => {
    const browser = h.browser("198.51.100.90");
    const token = formToken(await (await browser.get("/login")).text());
    const favicon = await browser.get("/favicon.ico");
    expect(favicon.headers.get("location")).toBe("/login");
    await browser.get("/login");

    const reply = await browser.post("/login", { _csrf: token, email: "someone@example.test" });

    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe("/login/code");
  });
});
