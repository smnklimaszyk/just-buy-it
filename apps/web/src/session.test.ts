import { changeRole, disablePerson } from "@ebay-sniper/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tokenHash } from "./auth/tokens.js";
import { signedInRecently } from "./session.js";
import { addPerson, createHarness, formToken, signIn, type Browser, type Harness } from "./testing/harness.js";

// Spec 7.4 and 7.7: what a session lets a browser do, against Postgres 18.

let h: Harness;

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.db.drop();
});

describe("pages behind the session", () => {
  it("send a browser without a session to /login on GET and refuse other methods with 401, and open with one", async () => {
    const stranger = h.browser("203.0.113.9");
    const get = await stranger.get("/products");
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("/login");
    expect((await stranger.post("/products", {})).status).toBe(401);

    await addPerson(h, "info@intra-ai.de", "admin");
    const owner = h.browser("198.51.100.7");
    await signIn(h, owner, "info@intra-ai.de");
    const page = await owner.get("/products");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Products");
  });

  it("give an editor 403 on the admin pages, People and Activity, for every method (spec 7.7)", async () => {
    await addPerson(h, "editor@example.test", "editor");
    const editor = h.browser("198.51.100.8");
    await signIn(h, editor, "editor@example.test");

    for (const path of ["/people", "/activity", "/people/add", "/activity?page=2"]) {
      const get = await editor.get(path);
      expect(get.status, path).toBe(403);
      expect(await get.text(), path).toContain("Only admins can change this. Ask an admin.");
      expect((await editor.post(path, {})).status, path).toBe(403);
    }
    expect((await editor.get("/settings")).status).toBe(200);
  });

  it("render in the app shell: People and Activity only for admins, and the sign-out and theme forms carry the session's CSRF token (spec 8.2)", async () => {
    const admin = h.browser("198.51.100.7");
    await signIn(h, admin, "info@intra-ai.de");
    const editor = h.browser("198.51.100.8");
    await signIn(h, editor, "editor@example.test");
    // The CSRF secret of the session the browser's cookie names.
    const csrf = async (browser: Browser) => {
      const row = await h.db.admin.query<{ csrf_secret: string }>("SELECT csrf_secret FROM auth.session WHERE token_hash = $1", [
        tokenHash(browser.cookies.get("__Host-jbi_session") ?? ""),
      ]);
      return row.rows[0]?.csrf_secret;
    };

    const adminPage = await (await admin.get("/deals")).text();
    expect(adminPage).toContain('<aside class="ia-shell__sidebar"');
    for (const label of ["Overview", "Deals", "Products", "Budget", "Settings", "People", "Activity", "Account", "Sign out"]) {
      expect(adminPage).toContain(`<span class="ia-side__label">${label}</span>`);
    }
    expect(adminPage).toMatch(/<a href="\/deals" aria-current="page"/);
    expect(adminPage).toContain('<form method="post" action="/logout" id="sign-out">');
    const adminCsrf = await csrf(admin);
    expect(adminCsrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(adminPage.match(/name="_csrf" value="([^"]+)"/g)).toEqual([`name="_csrf" value="${adminCsrf}"`, `name="_csrf" value="${adminCsrf}"`]);

    const editorPage = await (await editor.get("/deals")).text();
    expect(editorPage).not.toContain('<span class="ia-side__label">People</span>');
    expect(editorPage).not.toContain('<span class="ia-side__label">Activity</span>');
    expect(editorPage).toContain(`name="_csrf" value="${await csrf(editor)}"`);
  });
});

describe("session timeouts (spec 7.4)", () => {
  // The browser's session row.
  const sessionRow = async (browser: Browser) =>
    (
      await h.db.admin.query<{ last_seen_at: Date; ended_at: Date | null; end_reason: string | null }>(
        "SELECT last_seen_at, ended_at, end_reason FROM auth.session WHERE token_hash = $1",
        [tokenHash(browser.cookies.get("__Host-jbi_session") ?? "")],
      )
    ).rows[0];

  it("signs out a tab that only auto-refreshes after 24 h: ?auto=1 and X-Auto-Refresh never move last_seen_at", async () => {
    const tab = h.browser("198.51.100.10");
    await signIn(h, tab, "editor@example.test");
    const signedInAt = h.clock.now();

    h.clock.advance(6 * 60_000);
    expect((await tab.get("/deals?auto=1")).status).toBe(200);
    expect((await tab.get("/deals", { "X-Auto-Refresh": "1" })).status).toBe(200);
    expect((await sessionRow(tab))?.last_seen_at).toEqual(signedInAt);

    h.clock.set(new Date(signedInAt.getTime() + 24 * 3_600_000 + 1_000));
    const late = await tab.get("/deals?auto=1");
    expect(late.status).toBe(303);
    expect(late.headers.get("location")).toBe("/login");
    expect((await sessionRow(tab))?.end_reason).toBe("idle");
  });

  it("ends a session in daily use 7 days and 1 second after the sign-in, never extended", async () => {
    const browser = h.browser("198.51.100.11");
    await signIn(h, browser, "editor@example.test");
    const signedInAt = h.clock.now();

    // Used twice a day, so the idle timeout never ends it.
    for (let half = 1; half <= 13; half += 1) {
      h.clock.set(new Date(signedInAt.getTime() + half * 12 * 3_600_000));
      expect((await browser.get("/deals")).status, `after ${half * 12} h`).toBe(200);
    }
    h.clock.set(new Date(signedInAt.getTime() + 7 * 24 * 3_600_000 - 1_000));
    expect((await browser.get("/deals")).status).toBe(200);
    h.clock.set(new Date(signedInAt.getTime() + 7 * 24 * 3_600_000 + 1_000));
    expect((await browser.get("/deals")).status).toBe(303);
    expect((await sessionRow(browser))?.end_reason).toBe("absolute");
  });

  it("ends a person's sessions on a role change and on disable, and a code asked for before the disable fails after it", async () => {
    const ctx = { at: h.clock.now(), actor: "system:cli", userId: null };
    const moved = await addPerson(h, "moved@example.test", "editor");
    const movedBrowser = h.browser("198.51.100.12");
    await signIn(h, movedBrowser, "moved@example.test");
    expect(await changeRole(h.db.pool, { userId: moved, role: "admin" }, ctx)).toMatchObject({ ok: true, sessionsEnded: 1 });
    expect((await movedBrowser.get("/deals")).status).toBe(303);

    const gone = await addPerson(h, "gone@example.test", "editor");
    const goneBrowser = h.browser("198.51.100.13");
    await signIn(h, goneBrowser, "gone@example.test");
    const waiting = h.browser("198.51.100.14");
    const token = formToken(await (await waiting.get("/login")).text());
    await waiting.post("/login", { _csrf: token, email: "gone@example.test" });
    await h.background.settled();
    const code = /sign-in code: (\d{4}) (\d{4})/.exec(String(h.smtp.sent.filter((m) => m.to === "gone@example.test").at(-1)?.text));
    const codeToken = formToken(await (await waiting.get("/login/code")).text());

    expect(await disablePerson(h.db.pool, { userId: gone }, ctx)).toMatchObject({ ok: true, sessionsEnded: 1 });
    expect((await goneBrowser.get("/deals")).status).toBe(303);
    const late = await waiting.post("/login/code", { _csrf: codeToken, code: `${code?.[1]}${code?.[2]}` });
    expect(late.headers.get("location")).not.toBe("/");
  });
});

describe("signedInRecently (step-up, spec 7.4)", () => {
  it("is true for 15 minutes after the sign-in that made the session, and false after", () => {
    const createdAt = new Date("2026-10-21T10:00:00.000Z");
    const session = {
      session: { id: "s", userId: "u", csrfSecret: "c", createdAt, expiresAt: new Date(createdAt.getTime() + 7 * 24 * 3_600_000) },
      person: { id: "u", email: "info@intra-ai.de", role: "admin" as const },
    };

    expect(signedInRecently(session, new Date(createdAt.getTime() + 15 * 60_000))).toBe(true);
    expect(signedInRecently(session, new Date(createdAt.getTime() + 15 * 60_000 + 1))).toBe(false);
  });
});

describe("POST /theme (spec 8.1, 7.11)", () => {
  it("sets __Host-jbi_theme and goes back to the page, which then renders dark; only light or dark and only a path on this site", async () => {
    const browser = h.browser("198.51.100.15");
    await signIn(h, browser, "editor@example.test");
    const csrf = formToken(await (await browser.get("/deals")).text());

    const toggled = await browser.post("/theme", { _csrf: csrf, theme: "dark", back: "/deals" });
    expect(toggled.status).toBe(303);
    expect(toggled.headers.get("location")).toBe("/deals");
    expect(toggled.headers.getSetCookie()).toEqual(["__Host-jbi_theme=dark; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax"]);
    const page = await (await browser.get("/deals")).text();
    expect(page).toContain('<html lang="en" data-theme="dark">');
    expect(page).toContain('name="theme" value="light"');

    const script = await browser.post("/theme", { _csrf: csrf, theme: "light", back: "/deals" }, { Accept: "application/json" });
    expect(script.status).toBe(204);
    const offSite = await browser.post("/theme", { _csrf: csrf, theme: "light", back: "//evil.example/" });
    expect(offSite.headers.get("location")).toBe("/");
    expect((await browser.post("/theme", { _csrf: csrf, theme: "purple", back: "/deals" })).status).toBe(400);
  });
});

describe("POST /logout", () => {
  it("ends the session row, clears the cookie with Clear-Site-Data but never cookies, and a replayed cookie goes to /login", async () => {
    const browser = h.browser("198.51.100.9");
    await signIn(h, browser, "editor@example.test");
    const token = browser.cookies.get("__Host-jbi_session") ?? "";
    const csrf = formToken(await (await browser.get("/deals")).text());

    const response = await browser.post("/logout", { _csrf: csrf });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("clear-site-data")).toBe('"cache", "storage"');
    expect(response.headers.getSetCookie()).toEqual(["__Host-jbi_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax"]);
    const row = await h.db.admin.query("SELECT end_reason FROM auth.session WHERE token_hash = $1", [tokenHash(token)]);
    expect(row.rows).toEqual([{ end_reason: "logout" }]);

    const replay = await h.app.request("/deals", { headers: { Cookie: `__Host-jbi_session=${token}` } });
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe("/login");
  });
});
