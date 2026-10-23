import { afterAll, describe, expect, it, vi } from "vitest";
import type { StoredProduct } from "@ebay-sniper/db";
import { addPerson, createHarness, formToken, signIn, type Browser, type Harness } from "../../testing/harness.js";
import { seedAlert, seedCandidate, seedMarketValue, seedProduct } from "./testing/products.js";

// Spec 8.3 /products: the list of products with their status, price rule, limits, market value,
// candidates today and last deal; the empty state carries the one primary "Add product".

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const primaryButtons =(html: string): number => html.match(/ia-btn--primary/g)?.length ?? 0;

// The text of each cell of the table row that links the product's name.
function cells(html: string, name: string): string[] {
  const start = html.lastIndexOf("<tr>", html.indexOf(`>${name}</a>`));
  const row = html.slice(start, html.indexOf("</tr>", start));
  return [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("GET /products", () => {
  it("shows an empty state whose Add product is the page's only primary button", async () => {
    const hh = await harness();
    await addPerson(hh, "anna@example.test", "editor");
    const browser = hh.browser();
    await signIn(hh, browser, "anna@example.test");

    const response = await browser.get("/products");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Products - Just-Buy-It</title>");
    expect(html).toMatch(/<a href="\/products" aria-current="page"/);
    expect(html).toContain("No products yet");
    expect(html).toMatch(/<a href="\/products\/new" class="ia-btn [^"]*ia-btn--primary/);
    expect(primaryButtons(html)).toBe(1);
    expect(html).not.toContain("ia-pagehead__actions");
  });

  it("lists each product by name with its status badge", async () => {
    const { html, lens } = await listed();

    expect(html).toContain('<caption class="ia-sr">Products</caption>');
    expect(html).toContain(`<a href="/products/${lens.key}" class="ia-link">Portrait lens</a>`);
    expect([cells(html, "Portrait lens").slice(0, 2), cells(html, "Espresso machine").slice(0, 2)]).toEqual([
      ["Portrait lens", "Active"],
      ["Espresso machine", "Draft"],
    ]);
  });

  it("loads the scripts of the row menus and the archive dialog", async () => {
    const { html } = await listed();

    expect(html).toContain('<script type="module" src="/assets/menu.0123456789ab.js">');
    expect(html).toContain('<script type="module" src="/assets/dialog.0123456789ab.js">');
  });

  it("names the price rule: fixed max, or percent below the typical asking price with the cap", async () => {
    const { html } = await listed();

    expect([cells(html, "Portrait lens")[2], cells(html, "Road bike")[2]]).toEqual([
      "Fixed max EUR 450",
      "15 % below the typical asking price, never above EUR 550",
    ]);
  });

  it("shows the limit a listing would get now per watched condition group, and says when the cap applies", async () => {
    const { html } = await listed();

    expect([cells(html, "Portrait lens")[3], cells(html, "Road bike")[3]]).toEqual([
      "Used: EUR 450",
      // 85 % of EUR 612, rounded down to EUR 10; New has no reliable value yet (owner decision 7).
      "New: EUR 550, using your cap Used: EUR 520",
    ]);
  });

  it("shows the newest typical asking price per group with how sure it is", async () => {
    const { html } = await listed();

    expect([cells(html, "Portrait lens")[4], cells(html, "Road bike")[4]]).toEqual(["No value yet", "Used: EUR 612 Reliable"]);
  });

  it("counts today's candidates against the product's cap and says when the last deal was", async () => {
    const { html } = await listed();

    expect([cells(html, "Portrait lens").slice(5, 7), cells(html, "Road bike").slice(5, 7)]).toEqual([
      ["2 / 10", "3 h ago"],
      ["0 / 10", "None yet"],
    ]);
  });

  it("offers Edit, Pause or Resume, and Archive behind a confirm dialog per row, and Add product as the one primary", async () => {
    const { html, lens } = await listed();

    expect([cells(html, "Portrait lens")[7], cells(html, "Espresso machine")[7]]).toEqual(["Edit Pause Archive", "Edit Archive"]);
    expect(html).toContain(`<a href="/products/${lens.key}/edit" class="ia-menu__item`);
    expect(html).toContain(`<button type="submit" form="status-${lens.key}" name="status" value="paused"`);
    expect(html).toContain(`<form id="status-${lens.key}" method="post" action="/products/${lens.key}/status">`);
    expect(html).toContain(`commandfor="archive-${lens.key}" command="show-modal"`);
    expect(html).toContain(`<dialog id="archive-${lens.key}"`);
    expect(html).toMatch(/<div class="ia-pagehead__actions"><a href="\/products\/new" class="ia-btn [^"]*ia-btn--primary/);
    expect(primaryButtons(html)).toBe(1);
  });

  it("leaves archived products out unless that filter is chosen, and filters by status", async () => {
    const { html, browser } = await listed();
    const archived = await (await browser.get("/products?status=archived")).text();
    const drafts = await (await browser.get("/products?status=draft")).text();

    expect(html).not.toContain("Old pram");
    expect(html).toMatch(/<a href="\/products" aria-current="page" class="ia-tab/);
    expect(archived).toContain("Old pram");
    expect(archived).not.toContain("Portrait lens");
    expect(archived).toMatch(/<a href="\/products\?status=archived" aria-current="page" class="ia-tab/);
    expect(drafts).toContain("Espresso machine");
    expect(drafts).not.toContain("Road bike");
  });
});

describe("POST /products/:key/status", () => {
  it("pauses a product on the version the list showed, audits it as the person and goes back to the list", async () => {
    const { browser, bike } = await listed();
    const csrf = formToken(await (await browser.get("/products")).text());

    const response = await browser.post(`/products/${bike.key}/status`, { _csrf: csrf, version: String(bike.version), back: "/products", status: "paused" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/products");
    const hh = await harness();
    const stored = await hh.db.admin.query("SELECT status, version FROM app.product WHERE id = $1", [bike.id]);
    expect(stored.rows[0]).toEqual({ status: "paused", version: bike.version + 1 });
    const audit = await hh.db.admin.query<{ actor: string; detail: unknown }>(
      "SELECT actor, detail FROM app.audit_event WHERE action = 'product.status_changed' ORDER BY at DESC LIMIT 1",
    );
    expect(audit.rows[0]?.actor).toMatch(/^user:[0-9a-f-]{36}$/);
    expect(audit.rows[0]?.detail).toMatchObject({ key: bike.key, before: "active", after: "paused" });
  });
});

type Listed = { html: string; browser: Browser; lens: StoredProduct; bike: StoredProduct };

let seeded: Promise<Listed> | undefined;

// Four products and the worker's rows about them, seeded once for the list tests: a fixed-price
// lens with candidates and an alert, a road bike in market mode with a used value only, a draft
// and an archived product.
const listed = async (): Promise<Listed> =>
  (seeded ??= (async () => {
    const hh = await harness();
    await addPerson(hh, "ben@example.test", "editor");
    const browser = hh.browser("203.0.113.5");
    await signIn(hh, browser, "ben@example.test");
    const lens = await seedProduct(hh, { name: "Portrait lens", candidateCapPerDay: 10 });
    const bike = await seedProduct(hh, {
      name: "Road bike",
      categoryId: "177831",
      conditionIds: ["1000", "3000"],
      searchWords: ["rennrad"],
      mustWords: [["rennrad"]],
      priceMode: "below_market",
      belowMarketPct: 15,
      maxCents: 55_000,
    });
    await seedProduct(hh, { name: "Espresso machine", status: "draft", searchWords: ["siebträger"], mustWords: [["siebträger"]] });
    await seedProduct(hh, { name: "Old pram", status: "archived", searchWords: ["kinderwagen"], mustWords: [["kinderwagen"]] });
    const now = hh.clock.now().getTime();
    await seedMarketValue(hh, bike, { group: "used", status: "ok", valueCents: 61_200, computedAt: new Date(now - DAY) });
    await seedCandidate(hh, lens, { decision: "pending", createdAt: hh.clock.now() });
    const alerted = await seedCandidate(hh, lens, { decision: "alerted", createdAt: new Date(now - 3 * HOUR) });
    await seedCandidate(hh, lens, { decision: "alerted", createdAt: new Date(now - 2 * DAY) });
    await seedAlert(hh, lens, alerted, new Date(now - 3 * HOUR));
    return { html: await (await browser.get("/products")).text(), browser, lens, bike };
  })());
