import { afterAll, describe, expect, it, vi } from "vitest";
import { newToken, tokenHash } from "./auth/tokens.js";
import { addPerson, createHarness, signIn, type Harness } from "./testing/harness.js";
import { routeGroup, type RouteGroup } from "./route-groups.js";

vi.setConfig({ testTimeout: 30_000 });

// Spec 8.3: one page module of V6 behind each sidebar entry.
describe("mountPages", () => {
  let pages: Harness | undefined;
  afterAll(async () => {
    await pages?.db.drop();
  });

  it("mounts a page for each V6 module: overview, deals, products, budget, settings, people and activity", async () => {
    pages = await createHarness();
    await addPerson(pages, "info@intra-ai.de", "admin");
    const admin = pages.browser();
    await signIn(pages, admin, "info@intra-ai.de");

    for (const [path, title] of [
      ["/", "Overview"],
      ["/deals", "Deals"],
      ["/products", "Products"],
      ["/budget", "Budget"],
      ["/settings", "Settings"],
      ["/people", "People"],
      ["/activity", "Activity"],
    ] as const) {
      const response = await admin.get(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain(`<title>${title} - Just-Buy-It</title>`);
    }
  });
});

// Spec 7.1 and auth.md 15: a test walks every route of the app and checks its group. A new route
// that is not in this list fails it.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GROUPS: Record<string, RouteGroup> = {
  "GET /login": "public",
  "POST /login": "public",
  "GET /login/code": "public",
  "POST /login/code": "public",
  "GET /healthz": "public",
  "GET /assets/*": "public",
  "POST /logout": "session",
  "POST /theme": "session",
  "GET /account": "session",
  "POST /account/sign-out-everywhere": "session",
  "GET /": "session",
  "GET /deals": "session",
  "GET /products": "session",
  "GET /products/new": "session",
  "POST /products/new": "session",
  "POST /products/new/cost": "session",
  "GET /products/:key": "session",
  "GET /products/:key/deals": "session",
  "GET /products/:key/filtered": "session",
  "GET /products/:key/history": "session",
  "GET /products/:key/market": "session",
  "POST /products/:key/market": "session",
  "GET /products/:key/edit": "session",
  "POST /products/:key/edit": "session",
  "POST /products/:key/edit/cost": "session",
  "POST /products/:key/status": "session",
  "GET /budget": "session",
  "GET /settings": "session",
  "POST /settings": "session",
  "GET /settings/alerts": "session",
  "POST /settings/alerts": "session",
  "GET /settings/matching": "session",
  "POST /settings/matching": "session",
  "GET /people": "admin",
  "POST /people": "admin",
  [`POST /people/:id{${UUID}}/role`]: "admin",
  [`POST /people/:id{${UUID}}/end-sessions`]: "admin",
  [`POST /people/:id{${UUID}}/disable`]: "admin",
  "GET /activity": "admin",
};

// Spec 7.7: editors read Settings but may not change it, so these session routes answer an
// editor with the page's own 403.
const EDITOR_READ_ONLY: ReadonlySet<string> = new Set(["POST /settings", "POST /settings/alerts", "POST /settings/matching"]);

// A concrete path for a route pattern.
const pathOf = (pattern: string) =>
  pattern
    .replace("*", "styles.0123456789ab.css")
    .replace(":key", "p_unknown_key")
    .replace(/:id\{.*\}(?=\/)/, "00000000-0000-7000-8000-000000000001");

describe("route groups", () => {
  let h: Harness | undefined;
  afterAll(async () => {
    await h?.db.drop();
  });

  it("puts every route of the app in its group: public opens without a session, session needs one, admin refuses editors", async () => {
    h = await createHarness();
    const hh = h;
    const editor = await addPerson(hh, "editor@example.test", "editor");
    // A fresh editor session per request, since some routes end the one they get.
    const editorSession = async () => {
      const token = newToken();
      const csrf = newToken();
      const at = hh.clock.now();
      await hh.db.admin.query(
        `INSERT INTO auth.session (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $4, $5)`,
        [tokenHash(token), editor, csrf, at, new Date(at.getTime() + 3_600_000)],
      );
      return { cookie: `__Host-jbi_session=${token}`, csrf };
    };
    const request = (method: string, path: string, headers: Record<string, string>) =>
      hh.app.request(path, {
        method,
        headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded", ...headers },
        ...(method === "GET" ? {} : { body: "" }),
      });

    const routes = hh.app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`);
    expect([...new Set(routes)].sort()).toEqual(Object.keys(GROUPS).sort());

    for (const [route, group] of Object.entries(GROUPS)) {
      const [method = "GET", pattern = "/"] = route.split(" ");
      const path = pathOf(pattern);
      const anonymous = await request(method, path, {});
      const { cookie, csrf } = await editorSession();
      const asEditor = await request(method, path, { Cookie: cookie, "X-CSRF-Token": csrf });

      expect(routeGroup(path), route).toBe(group);
      // A public route answers on its own terms (GET /login/code without an attempt also goes to
      // /login), but never with the guard's 401.
      if (group === "public") {
        expect(anonymous.status, route).not.toBe(401);
        continue;
      }
      expect(anonymous.status, route).toBe(method === "GET" ? 303 : 401);
      if (method === "GET") expect(anonymous.headers.get("location"), route).toBe("/login");
      // With a session the guard lets an editor through to every route but the admin ones.
      if (group === "admin" || EDITOR_READ_ONLY.has(route)) expect(asEditor.status, route).toBe(403);
      else expect([401, 403], route).not.toContain(asEditor.status);
    }
  });

  it("never writes a row on a GET (spec 7.6), except that a non-automatic request may move last_seen_at", async () => {
    const hh = h ?? (h = await createHarness());
    await addPerson(hh, "info@intra-ai.de", "admin");
    const admin = hh.browser("198.51.100.7");
    await signIn(hh, admin, "info@intra-ai.de");
    const everyRow = async () => {
      const tables = await hh.db.admin.query<{ name: string }>(
        `SELECT format('%I.%I', table_schema, table_name) AS name FROM information_schema.tables
         WHERE table_schema IN ('app', 'auth', 'ebay_live') AND table_type = 'BASE TABLE' ORDER BY 1`,
      );
      const rows: string[] = [];
      for (const { name } of tables.rows) {
        const result = await hh.db.admin.query<{ row: string }>(`SELECT t::text AS row FROM ${name} t ORDER BY 1`);
        rows.push(...result.rows.map((r) => `${name} ${r.row}`));
      }
      return rows;
    };

    const before = await everyRow();
    hh.clock.advance(10 * 60_000);
    for (const route of Object.keys(GROUPS).filter((r) => r.startsWith("GET "))) {
      const path = pathOf(route.slice(4));
      await admin.get(`${path}${path.includes("?") ? "&" : "?"}auto=1`);
    }

    expect(await everyRow()).toEqual(before);
  });
});
