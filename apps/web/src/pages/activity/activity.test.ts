import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, signIn, type Browser, type Harness } from "../../testing/harness.js";

// Spec 8.3 /activity and 7.12: the audit log and the sign-in events, newest first, for admins.

let h: Harness | undefined;
let admin: Browser | undefined;

vi.setConfig({ testTimeout: 30_000 });

async function signedIn(): Promise<{ hh: Harness; browser: Browser }> {
  if (h !== undefined && admin !== undefined) return { hh: h, browser: admin };
  const hh = (h = await createHarness());
  await addPerson(hh, "admin@example.test", "admin");
  admin = hh.browser("198.51.100.7");
  await signIn(hh, admin, "admin@example.test");
  return { hh, browser: admin };
}

afterAll(async () => {
  await h?.db.drop();
});

// The text of each cell of every body row, in order.
function rows(html: string): string[][] {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) =>
      (m[1] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
}

describe("GET /activity", () => {
  it("lists changes and sign-in events together, newest first, with who did it and the IP as /24", async () => {
    const { hh, browser } = await signedIn();
    const id = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'admin@example.test'");
    hh.clock.advance(60_000);
    await hh.db.admin.query(
      `INSERT INTO app.audit_event (at, actor, action, detail) VALUES ($1, $2, 'user.added', '{"email": "new@example.test", "role": "editor"}')`,
      [hh.clock.now(), `user:${String(id.rows[0]?.id)}`],
    );

    const response = await browser.get("/activity");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Activity - Just-Buy-It</title>");
    const [newest, signInRow] = rows(html);
    // jsonb keeps its keys shortest first.
    expect(newest).toEqual(["just now", "Change", "user.added", "admin@example.test", "", "role: editor, email: new@example.test"]);
    expect(signInRow?.slice(1, 5)).toEqual(["Sign-in", "login_succeeded", "admin@example.test", "198.51.100.0/24"]);
  });

  it("filters by kind with a plain GET form", async () => {
    const { browser } = await signedIn();

    const html = await (await browser.get("/activity?kind=auth")).text();

    expect(html).toMatch(/<form method="get" action="\/activity"/);
    expect(html).toMatch(/<option value="auth" selected="">Sign-in<\/option>/);
    const kinds = new Set(rows(html).map((row) => row[1]));
    expect([...kinds]).toEqual(["Sign-in"]);
  });

  it("filters by event, offering the events that are in the logs", async () => {
    const { browser } = await signedIn();

    const html = await (await browser.get("/activity?event=user.added")).text();

    expect(html).toMatch(/<option value="user.added" selected="">user.added<\/option>/);
    expect(html).toContain('<option value="login_succeeded">login_succeeded</option>');
    expect(rows(html).map((row) => row[2])).toEqual(["user.added"]);
  });

  it("shows 50 rows a page, with pages that keep the filter", async () => {
    const { hh, browser } = await signedIn();
    await hh.db.admin.query(
      `INSERT INTO app.audit_event (at, actor, action, detail)
       SELECT $1::timestamptz - n * interval '1 minute', 'system:cli', 'setting.changed', jsonb_build_object('key', 'alerts.per_day', 'after', n)
       FROM generate_series(1, 60) AS n`,
      [hh.clock.now()],
    );

    const first = await (await browser.get("/activity?kind=audit")).text();
    const second = await (await browser.get("/activity?kind=audit&page=2")).text();

    expect(rows(first)).toHaveLength(50);
    expect(first).toContain("1–50 of 61");
    expect(first).toContain('href="/activity?kind=audit&amp;page=2"');
    expect(rows(second)).toHaveLength(11);
    expect(rows(second)[0]?.[3]).toBe("ops CLI");
  });

  it("is for admins only: an editor gets 403", async () => {
    const { hh } = await signedIn();
    await addPerson(hh, "editor@example.test", "editor");
    const editor = hh.browser("203.0.113.9");
    await signIn(hh, editor, "editor@example.test");

    const response = await editor.get("/activity");

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("login_succeeded");
  });

  it("shows a hostile value in the details as text", async () => {
    const { hh, browser } = await signedIn();
    await hh.db.admin.query(
      `INSERT INTO app.audit_event (at, actor, action, detail) VALUES ($1, 'system:cli', 'product.updated', $2)`,
      [hh.clock.now(), { name: '"><script>alert(1)</script><a href="javascript:x">' }],
    );

    const html = await (await browser.get("/activity?event=product.updated")).text();

    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
