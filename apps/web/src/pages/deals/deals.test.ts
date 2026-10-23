import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, signIn, START, type Browser, type Harness } from "../../testing/harness.js";
import { seedAlert, seedCandidate, seedProduct } from "../products/testing/products.js";

// Spec 8.3 /deals: every alert and every held or wrong-product candidate, filtered by product
// and decision, 50 to a page.

let h: Harness | undefined;
let browser: Browser | undefined;

vi.setConfig({ testTimeout: 30_000 });

async function signedIn(): Promise<{ hh: Harness; browser: Browser }> {
  if (h !== undefined && browser !== undefined) return { hh: h, browser };
  const hh = (h = await createHarness());
  await addPerson(hh, "editor@example.test", "editor");
  browser = hh.browser();
  await signIn(hh, browser, "editor@example.test");
  return { hh, browser };
}

afterAll(async () => {
  await h?.db.drop();
});

beforeEach(async () => {
  const { hh } = await signedIn();
  hh.clock.set(START);
  await hh.db.admin.query(`TRUNCATE app.alert, app.candidate, app.screening, ebay_live.screening_text, ebay_live.listing_content,
    ebay_live.listing, app.product_revision, app.search_product, app.search, app.product_source, app.product CASCADE`);
});

const minutesAgo = (hh: Harness, n: number): Date => new Date(hh.clock.now().getTime() - n * 60_000);

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

describe("GET /deals", () => {
  it("lists the alerts and the held and wrong-product candidates, newest first, with the outcome as a Badge", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    const bike = await seedProduct(hh, { name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const alerted = await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 10), title: "Lens one", limitCents: 50_000 });
    await seedAlert(hh, lens, alerted, minutesAgo(hh, 10));
    const blocked = await seedCandidate(hh, lens, { decision: "blocked", createdAt: minutesAgo(hh, 20), title: "Lens two", limitCents: 50_000 });
    await seedAlert(hh, lens, blocked, minutesAgo(hh, 20));
    await hh.db.admin.query("UPDATE app.alert SET final_verdict = 'block' WHERE candidate_id = $1", [blocked]);
    await seedCandidate(hh, bike, { decision: "held", createdAt: minutesAgo(hh, 30), title: "Bike one", heldReason: "claude_unavailable" });
    await seedCandidate(hh, bike, {
      decision: "wrong_product",
      createdAt: minutesAgo(hh, 40),
      title: "Frame only",
      claudeReason: "A frame set, not a bike.",
      productMatch: "mismatch",
    });
    await seedCandidate(hh, bike, { decision: "pending", createdAt: minutesAgo(hh, 5), title: "Pending bike" });

    const response = await browser.get("/deals");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Deals - Just-Buy-It</title>");
    expect(rows(html).map((row) => [row[0], row[1], row[5]])).toEqual([
      ["10 min ago", "Portrait lens", "Alerted"],
      ["20 min ago", "Portrait lens", "Blocked"],
      ["30 min ago", "Road bike", "Held"],
      ["40 min ago", "Road bike", "Wrong product"],
    ]);
    expect(html).not.toContain("Pending bike");
  });

  it("colours the outcome, and says why a candidate was held or what Claude found wrong", async () => {
    const { hh, browser } = await signedIn();
    const bike = await seedProduct(hh, { name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    await seedCandidate(hh, bike, { decision: "held", createdAt: minutesAgo(hh, 30), title: "Bike one", heldReason: "claude_unavailable" });
    await seedCandidate(hh, bike, {
      decision: "wrong_product",
      createdAt: minutesAgo(hh, 40),
      title: "Frame only",
      claudeReason: "A frame set, not a bike.",
      productMatch: "mismatch",
    });

    const html = await (await browser.get("/deals")).text();

    expect(rows(html).map((row) => row[6])).toEqual(["Not checked by Claude Claude unavailable", "Not this product A frame set, not a bike."]);
    expect(html).toMatch(/ia-badge--warning[^>]*>[\s\S]*?Held<\/span>/);
    expect(html).toMatch(/ia-badge--neutral[^>]*>Wrong product<\/span>/);
  });

  it("filters by product and by outcome from a plain GET form, and ignores values it does not know", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    const bike = await seedProduct(hh, { name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    await seedCandidate(hh, lens, { decision: "held", createdAt: minutesAgo(hh, 10), title: "Held lens" });
    await seedCandidate(hh, bike, { decision: "held", createdAt: minutesAgo(hh, 20), title: "Held bike" });
    await seedCandidate(hh, bike, { decision: "wrong_product", createdAt: minutesAgo(hh, 30), title: "Wrong bike" });

    const bikes = await (await browser.get(`/deals?product=${bike.key}`)).text();
    const heldBikes = await (await browser.get(`/deals?product=${bike.key}&decision=held`)).text();
    const unknown = await (await browser.get("/deals?product=p_nothing&decision=pending")).text();

    expect(rows(bikes).map((row) => row[2])).toEqual(["Held bike", "Wrong bike"]);
    expect(rows(heldBikes).map((row) => row[2])).toEqual(["Held bike"]);
    expect(rows(unknown).map((row) => row[2])).toEqual(["Held lens", "Held bike", "Wrong bike"]);
    expect(heldBikes).toContain('<form method="get" action="/deals"');
    expect(heldBikes).toContain(`<option value="${bike.key}" selected="">Road bike</option>`);
    expect(heldBikes).toContain('<option value="held" selected="">Held</option>');
    expect(heldBikes).toContain(`<option value="${lens.key}">Portrait lens</option>`);
  });

  it("pages over 50 rows and keeps the filter on the page links", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    for (let n = 0; n < 53; n += 1) {
      await seedCandidate(hh, lens, { decision: "held", createdAt: minutesAgo(hh, n + 1), title: `Held ${String(n)}` });
    }

    const first = await (await browser.get("/deals?decision=held")).text();
    const second = await (await browser.get("/deals?decision=held&page=2")).text();
    const nonsense = await (await browser.get("/deals?page=x")).text();

    expect(rows(first)).toHaveLength(50);
    expect(first).toContain("1–50 of 53");
    expect(first).toContain('href="/deals?decision=held&amp;page=2"');
    expect(rows(second).map((row) => row[2])).toEqual(["Held 50", "Held 51", "Held 52"]);
    expect(rows(nonsense)).toHaveLength(50);
  });

  it("shows the item price with '+ shipping' while shipping is unknown, and a per-GB limit per GB", async () => {
    const { hh, browser } = await signedIn();
    const ram = await seedProduct(hh, { name: "Memory kit", perGb: true, unitMinTotal: 16, unitMaxTotal: 64, maxCents: 300 });
    const id = await seedCandidate(hh, ram, { decision: "held", createdAt: minutesAgo(hh, 10), title: "64 GB kit", limitCents: 250 });
    await hh.db.admin.query("UPDATE app.candidate SET price_cents = 12000, landed_cents = NULL, shipping_known = false, total_gb = 64 WHERE id = $1", [id]);

    const html = await (await browser.get("/deals")).text();

    expect(rows(html)[0]?.slice(3, 5)).toEqual(["EUR 120 + shipping", "EUR 2.50 per GB 75 % of limit"]);
  });

  it("says what will appear when there is no deal yet, and no pager", async () => {
    const { browser } = await signedIn();

    const html = await (await browser.get("/deals")).text();

    expect(html).toContain("No deals yet. Alerts and held or wrong-product candidates appear here.");
    expect(html).not.toContain('<caption class="ia-sr">Deals, newest first</caption>');
    expect(html).not.toContain('aria-label="Pagination"');
  });
});
