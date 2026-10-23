import { berlinDay } from "@ebay-sniper/domain";
import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, signIn, type Browser, type Harness } from "../../testing/harness.js";
import { seedProduct } from "../products/testing/products.js";

// Spec 8.3 /budget: the daily call plan by line against 2,500, the searches, today's eBay quota
// and today's Claude calls per product.

let h: Harness | undefined;
let browser: Browser | undefined;

vi.setConfig({ testTimeout: 30_000 });

const ROAD_BIKE = {
  name: "Road bike",
  description: "Used road bike, 56 cm frame, carbon. Not a frame set, not an e-bike.",
  categoryId: "177831",
  categoryName: "Road bikes",
  searchWords: ["rennrad"],
  mustWords: [["rennrad"]],
  speed: "fast",
  priceDropCheck: true,
};

// One editor signed in, a lens at normal speed and a road bike at fast speed with the price-drop
// check: polls 240 + 528, overflow 20, sweeps 24, getItem 126 at 40 Claude calls, market 3 x 22.
async function signedIn(): Promise<{ hh: Harness; browser: Browser }> {
  if (h !== undefined && browser !== undefined) return { hh: h, browser };
  const hh = (h = await createHarness());
  await addPerson(hh, "editor@example.test", "editor");
  await seedProduct(hh, { categoryName: "Lenses" });
  await seedProduct(hh, ROAD_BIKE);
  browser = hh.browser();
  await signIn(hh, browser, "editor@example.test");
  return { hh, browser };
}

afterAll(async () => {
  await h?.db.drop();
});

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

describe("GET /budget", () => {
  it("shows the plan by line, its total against 2,500 and the room left, to an editor too", async () => {
    const { browser } = await signedIn();

    const response = await browser.get("/budget");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Budget - Just-Buy-It</title>");
    expect(cells(html, "Polls")).toEqual(["Polls", "768"]);
    expect(cells(html, "Overflow pages")).toEqual(["Overflow pages", "20"]);
    expect(cells(html, "Price-drop sweeps")).toEqual(["Price-drop sweeps", "24"]);
    expect(cells(html, "Item details for the Claude check")).toEqual(["Item details for the Claude check", "126"]);
    expect(cells(html, "Market value")).toEqual(["Market value", "66"]);
    expect(cells(html, "Total")).toEqual(["Total", "1,004"]);
    expect(html).toContain("1,496 calls a day left of 2,500.");
    expect(html).toMatch(/<meter min="0" max="2500" value="1004"/);
  });

  it("lists the live searches with category name, query, speed, products and last poll", async () => {
    const { hh, browser } = await signedIn();
    const searches = await hh.db.admin.query<{ id: string; q: string; category_id: string }>(
      "SELECT id, q, category_id FROM app.search WHERE retired_at IS NULL",
    );
    const lens = searches.rows.find((search) => search.category_id === "3323");
    const bike = searches.rows.find((search) => search.category_id === "177831");
    if (lens === undefined || bike === undefined) throw new Error("the two searches are missing");
    const tenMinutesAgo = new Date(hh.clock.now().getTime() - 10 * 60_000);
    await hh.db.admin.query("INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status) VALUES ($1, 'poll', $2, $2, 'ok')", [
      bike.id,
      tenMinutesAgo,
    ]);

    const html = await (await browser.get("/budget")).text();

    expect(cells(html, bike.id)).toEqual([bike.id, "Road bikes", bike.q, "Fast", "Road bike", "10 min ago"]);
    expect(cells(html, lens.id)).toEqual([lens.id, "Lenses", lens.q, "Normal", "Portrait lens", "Never"]);
  });

  it("shows the eBay calls used in the current quota window against the hard cap of 4,000", async () => {
    const { hh, browser } = await signedIn();
    const now = hh.clock.now().getTime();
    await hh.db.admin.query(
      `INSERT INTO app.ebay_quota_window (resource, window_start, window_end, used, used_standard, used_alert_path)
       VALUES ('buy.browse', $1, $2, 1234, 1200, 34)`,
      [new Date(now - 3_600_000), new Date(now + 20 * 3_600_000)],
    );

    const html = await (await browser.get("/budget")).text();

    expect(html).toContain("eBay calls used in this quota window");
    expect(html).toMatch(/<meter min="0" max="4000" value="1234"/);
  });

  it("lists today's Claude calls per product by name, a key without a product as the key, and the per-product share", async () => {
    const { hh, browser } = await signedIn();
    const lens = await hh.db.admin.query<{ key: string }>("SELECT key FROM app.product WHERE name = 'Portrait lens'");
    const today = berlinDay(hh.clock.now());
    await hh.db.admin.query(
      `INSERT INTO app.llm_usage_product_daily (day_berlin, product_key, calls)
       VALUES ($1, $2, 12), ($1, 'gpu_3090', 3), ('2026-10-20', $2, 30)`,
      [today, lens.rows[0]?.key],
    );

    const html = await (await browser.get("/budget")).text();

    expect(cells(html, "Portrait lens")).toEqual(["Portrait lens", "12"]);
    expect(cells(html, "gpu_3090")).toEqual(["gpu_3090", "3"]);
    expect(html).toContain("While two or more products are active, one product gets at most 20 of the 40 Claude checks a day.");
  });
});
