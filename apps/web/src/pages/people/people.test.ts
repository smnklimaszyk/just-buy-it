import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, signIn, type Browser, type Harness } from "../../testing/harness.js";

// Spec 8.3 /people and 7.7: admins add people, change their role, end their sessions and disable
// them. Each change needs a sign-in in the last 15 minutes (spec 7.4 step-up).

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const primaryButtons = (html: string): number => html.match(/ia-btn--primary/g)?.length ?? 0;

// The text of each cell of the table row whose row header reads `first`.
function cells(html: string, first: string): string[] {
  const at = html.search(new RegExp(`<th scope="row"[^>]*>${first}</th>`));
  const start = html.lastIndexOf("<tr>", at);
  const row = html.slice(start, html.indexOf("</tr>", start));
  return [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

const MINUTE = 60_000;

// One browser per address, so its device cookie keeps the sign-in caps per device.
const browsers = new Map<string, Browser>();

// The address's browser, signed in again now (a fresh session passes the step-up). Adds the
// person when they are new. The clock moves on 20 minutes first, so the 5 codes an hour of one
// device hold across the file.
async function signedIn(email: string, role: "admin" | "editor"): Promise<{ hh: Harness; browser: Browser }> {
  const hh = await harness();
  hh.clock.advance(20 * MINUTE);
  const found = await hh.db.admin.query("SELECT 1 FROM auth.app_user WHERE email = $1", [email]);
  if (found.rowCount === 0) await addPerson(hh, email, role);
  const browser = browsers.get(email) ?? hh.browser();
  browsers.set(email, browser);
  await signIn(hh, browser, email);
  return { hh, browser };
}

describe("GET /people", () => {
  it("lists each person with role, status, last sign-in and devices, and offers Add person as the one primary", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await addPerson(hh, "gone@example.test", "editor", "disabled");

    const response = await browser.get("/people");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>People - Just-Buy-It</title>");
    const [, adminRole, adminStatus, adminSignIn, adminDevices] = cells(html, "admin@example.test");
    expect([adminRole, adminStatus]).toEqual(["Admin", "Active"]);
    expect(adminSignIn).toBe("just now");
    expect(adminDevices).toBe("1");
    expect(cells(html, "gone@example.test").slice(0, 5)).toEqual(["gone@example.test", "Editor", "Disabled", "Never", "0"]);
    // The dialog is its own view with its own primary.
    expect(primaryButtons(html.replace(/<dialog[\s\S]*?<\/dialog>/g, ""))).toBe(1);
    expect(html).toMatch(/commandfor="add-person" command="show-modal"[^>]*class="ia-btn[^"]*ia-btn--primary/);
    expect(html).toMatch(/<dialog id="add-person"[\s\S]*<form method="post" action="\/people"/);
  });

  it("offers Make admin in the row menu of an editor, as a button of the row's own form", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const id = await addPerson(hh, "menu@example.test", "editor");

    const html = await (await browser.get("/people")).text();

    expect(html).toMatch(new RegExp(`<form id="role-${id}" method="post" action="/people/${id}/role">`));
    expect(html).toMatch(new RegExp(`<button type="submit" form="role-${id}" name="role" value="admin"[^>]*>[\\s\\S]*?Make admin`));
  });

  it("offers End sessions, and Disable last behind a confirm dialog that posts to the disable route", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const id = await addPerson(hh, "menu2@example.test", "editor");

    const html = await (await browser.get("/people")).text();

    expect(html).toMatch(new RegExp(`<form id="end-${id}" method="post" action="/people/${id}/end-sessions">`));
    expect(html).toMatch(new RegExp(`<button type="submit" form="end-${id}"[^>]*>[\\s\\S]*?End sessions`));
    expect(html).toMatch(new RegExp(`<button type="button" commandfor="disable-${id}" command="show-modal" class="[^"]*is-danger"`));
    expect(html).toMatch(new RegExp(`<dialog id="disable-${id}"[\\s\\S]*?Disable menu2@example.test\\?[\\s\\S]*?action="/people/${id}/disable"`));
  });

  it("offers no row menu for a disabled person", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const id = await addPerson(hh, "off@example.test", "editor", "disabled");

    const html = await (await browser.get("/people")).text();

    expect(html).not.toContain(`/people/${id}/`);
    expect(html).not.toContain("Actions for off@example.test");
  });

  it("says before any change when the sign-in is more than 15 minutes old", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    expect(await (await browser.get("/people")).text()).not.toContain("Changes to people need a sign-in in the last 15 minutes.");
    hh.clock.advance(16 * MINUTE);

    const response = await browser.get("/people");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Changes to people need a sign-in in the last 15 minutes. Sign in again, then make the change.");
  });

  it("is for admins only: an editor gets 403 on the page and on a change", async () => {
    const { hh, browser } = await signedIn("plain.editor@example.test", "editor");
    const csrf = formToken(await (await browser.get("/account")).text());

    const page = await browser.get("/people");
    const add = await browser.post("/people", { _csrf: csrf, email: "sneaky@example.test", role: "admin" });

    expect(page.status).toBe(403);
    expect(await page.text()).toContain("Only admins can change this. Ask an admin.");
    expect(add.status).toBe(403);
    expect((await hh.db.admin.query("SELECT 1 FROM auth.app_user WHERE email = 'sneaky@example.test'")).rowCount).toBe(0);
  });

  it("loads the scripts of the row menus and the dialogs", async () => {
    const { browser } = await signedIn("admin@example.test", "admin");

    const html = await (await browser.get("/people")).text();

    expect(html).toContain('<script type="module" src="/assets/menu.0123456789ab.js">');
    expect(html).toContain('<script type="module" src="/assets/dialog.0123456789ab.js">');
  });
});

describe("POST /people", () => {
  it("adds a person with the role chosen, audited as the admin, right after a sign-in", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const csrf = formToken(await (await browser.get("/people")).text());

    const response = await browser.post("/people", { _csrf: csrf, email: " New.Person@Example.test ", role: "editor" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/people");
    const added = await hh.db.admin.query("SELECT email::text AS email, role, status FROM auth.app_user WHERE email = 'new.person@example.test'");
    expect(added.rows).toEqual([{ email: "new.person@example.test", role: "editor", status: "active" }]);
    const admin = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'admin@example.test'");
    const audit = await hh.db.admin.query("SELECT actor, detail FROM app.audit_event WHERE action = 'user.added'");
    expect(audit.rows).toEqual([{ actor: `user:${String(admin.rows[0]?.id)}`, detail: { email: "new.person@example.test", role: "editor" } }]);
  });

  it("refuses to add a person more than 15 minutes after the sign-in and asks for a new sign-in", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const csrf = formToken(await (await browser.get("/people")).text());
    hh.clock.advance(16 * MINUTE);

    const response = await browser.post("/people", { _csrf: csrf, email: "late@example.test", role: "editor" });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Changes to people need a sign-in in the last 15 minutes. Sign in again, then make the change.");
    expect((await hh.db.admin.query("SELECT 1 FROM auth.app_user WHERE email = 'late@example.test'")).rowCount).toBe(0);
  });

  it("refuses an input that is not one address, and an address that is already on the list", async () => {
    const { browser } = await signedIn("admin@example.test", "admin");
    const csrf = formToken(await (await browser.get("/people")).text());

    const invalid = await browser.post("/people", { _csrf: csrf, email: "two@at@example.test", role: "editor" });

    expect(invalid.status).toBe(422);
    expect(await invalid.text()).toContain("Enter one email address, for example anna@example.com.");

    const known = await browser.post("/people", { _csrf: csrf, email: "ADMIN@example.test", role: "editor" });

    expect(known.status).toBe(409);
    expect(await known.text()).toContain("admin@example.test is already on the list.");
  });
});

describe("POST /people/:id/end-sessions", () => {
  it("ends every session of the person, audited, after a recent sign-in only", async () => {
    const { browser: theirs } = await signedIn("lost.laptop@example.test", "editor");
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const person = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'lost.laptop@example.test'");
    const id = String(person.rows[0]?.id);
    const csrf = formToken(await (await browser.get("/people")).text());

    const response = await browser.post(`/people/${id}/end-sessions`, { _csrf: csrf });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/people");
    expect((await theirs.get("/deals")).status).toBe(303);
    expect((await browser.get("/deals")).status).toBe(200);
    const audit = await hh.db.admin.query("SELECT detail->>'email' AS email FROM app.audit_event WHERE action = 'user.sessions_ended'");
    expect(audit.rows).toEqual([{ email: "lost.laptop@example.test" }]);
  });
});

describe("POST /people/:id/disable", () => {
  it("disables the person and ends their sessions, audited", async () => {
    const { browser: theirs } = await signedIn("leaver@example.test", "editor");
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const person = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'leaver@example.test'");
    const id = String(person.rows[0]?.id);
    const csrf = formToken(await (await browser.get("/people")).text());

    const response = await browser.post(`/people/${id}/disable`, { _csrf: csrf });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/people");
    expect((await hh.db.admin.query("SELECT status FROM auth.app_user WHERE id = $1", [id])).rows).toEqual([{ status: "disabled" }]);
    expect((await theirs.get("/deals")).status).toBe(303);
    const audit = await hh.db.admin.query("SELECT detail->>'email' AS email FROM app.audit_event WHERE action = 'user.disabled'");
    expect(audit.rows).toEqual([{ email: "leaver@example.test" }]);
  });

  it("needs a recent sign-in to disable someone or end their sessions", async () => {
    const { browser: theirs } = await signedIn("stays@example.test", "editor");
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const person = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'stays@example.test'");
    const id = String(person.rows[0]?.id);
    const csrf = formToken(await (await browser.get("/people")).text());
    hh.clock.advance(16 * MINUTE);

    const disable = await browser.post(`/people/${id}/disable`, { _csrf: csrf });
    const end = await browser.post(`/people/${id}/end-sessions`, { _csrf: csrf });

    expect([disable.status, end.status]).toEqual([403, 403]);
    expect((await hh.db.admin.query("SELECT status FROM auth.app_user WHERE id = $1", [id])).rows).toEqual([{ status: "active" }]);
    expect((await theirs.get("/deals")).status).toBe(200);
  });
});

describe("POST /people/:id/role", () => {
  it("makes an editor an admin from the row menu and ends their sessions so the role applies at once", async () => {
    const { browser: editorBrowser } = await signedIn("ed@example.test", "editor");
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const ed = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'ed@example.test'");
    const id = String(ed.rows[0]?.id);
    const html = await (await browser.get("/people")).text();

    const response = await browser.post(`/people/${id}/role`, { _csrf: formToken(html), role: "admin" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/people");
    expect((await hh.db.admin.query("SELECT role FROM auth.app_user WHERE id = $1", [id])).rows).toEqual([{ role: "admin" }]);
    expect((await editorBrowser.get("/deals")).status).toBe(303);
  });

  it("answers 404 for an id that is no person", async () => {
    const { browser } = await signedIn("admin@example.test", "admin");
    const csrf = formToken(await (await browser.get("/people")).text());

    const malformed = await browser.post("/people/not-a-uuid/role", { _csrf: csrf, role: "admin" });
    const unknown = await browser.post("/people/01a166fd-0000-7000-8000-000000000000/disable", { _csrf: csrf });

    expect([malformed.status, unknown.status]).toEqual([404, 404]);
  });

  it("needs a recent sign-in for a role change too", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    const id = await addPerson(hh, "slow@example.test", "editor");
    const csrf = formToken(await (await browser.get("/people")).text());
    hh.clock.advance(16 * MINUTE);

    const response = await browser.post(`/people/${id}/role`, { _csrf: csrf, role: "admin" });

    expect(response.status).toBe(403);
    expect((await hh.db.admin.query("SELECT role FROM auth.app_user WHERE id = $1", [id])).rows).toEqual([{ role: "editor" }]);
  });

  it("refuses to make the last active admin an editor", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("UPDATE auth.app_user SET role = 'editor' WHERE email <> 'admin@example.test'");
    const admin = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'admin@example.test'");
    const csrf = formToken(await (await browser.get("/people")).text());

    const response = await browser.post(`/people/${String(admin.rows[0]?.id)}/role`, { _csrf: csrf, role: "editor" });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("admin@example.test is the last active admin. Make someone else an admin first.");
    expect((await hh.db.admin.query("SELECT role FROM auth.app_user WHERE email = 'admin@example.test'")).rows).toEqual([{ role: "admin" }]);
  });
});
