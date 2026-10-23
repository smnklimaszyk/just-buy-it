import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, signIn, type Browser, type Harness } from "../../testing/harness.js";
import { seedMarketValue, seedProduct } from "./testing/products.js";

// Spec 8.3 /products/:key: the product page with its tabs Overview, Deals, Filtered out and
// History, and the market box of spec 6.5.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const primaryButtons = (html: string): string[] =>
  [...html.matchAll(/class="ia-btn [^"]*ia-btn--primary[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span class="ia-btn__label">([^<]*)</g)].map((m) => m[1] ?? "");

const DAY = 86_400_000;

// The market box as text: tags out, spaces collapsed.
function marketText(html: string): string {
  const start = html.indexOf('<section id="market"');
  return html
    .slice(start, html.indexOf("</section>", start))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let editor: Promise<Browser> | undefined;

const signedInEditor = async () =>
  (editor ??= (async () => {
    const hh = await harness();
    await addPerson(hh, "anna@example.test", "editor");
    const browser = hh.browser();
    await signIn(hh, browser, "anna@example.test");
    return browser;
  })());

describe("GET /products/:key", () => {
  it("shows a draft with its badge, Activate product as the one primary, the four tabs and its rules", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const draft = await seedProduct(hh, { status: "draft", categoryName: "Objektive", excludeWords: ["defekt*", "~kratzer"] });

    const response = await browser.get(`/products/${draft.key}`);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Portrait lens - Just-Buy-It</title>");
    expect(html).toMatch(/<h1 class="ia-pagehead__title type-title-lg">Portrait lens<\/h1>/);
    expect(html).toContain('<span class="ia-badge type-ui-caption ia-badge--info">');
    expect(primaryButtons(html)).toEqual(["Activate product"]);
    expect([...html.matchAll(/<a href="([^"]+)"[^>]*class="ia-tab[^"]*">([^<]+)</g)].map((m) => [m[1], m[2]])).toEqual([
      [`/products/${draft.key}`, "Overview"],
      [`/products/${draft.key}/deals`, "Deals"],
      [`/products/${draft.key}/filtered`, "Filtered out"],
      [`/products/${draft.key}/history`, "History"],
    ]);
    expect(html).toMatch(new RegExp(`<a href="/products/${draft.key}" aria-current="page" class="ia-tab`));
    for (const text of ["85mm, portraitobjektiv", "defekt*, ~kratzer", "3323 Objektive", "Used", "Fixed max EUR 450"]) expect(html).toContain(text);
  });

  it("says on the Overview what the product costs a day in eBay calls", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const draft = await seedProduct(hh, { status: "draft", name: "Costed lens", categoryId: "3334" });

    const html = await (await browser.get(`/products/${draft.key}`)).text();

    expect(html).toMatch(/Once active, this product adds about 253 eBay calls a day: \d[\d,]* of 2,500 planned\./);
  });

  it("activates a draft from its page, which then offers Edit product as its primary", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const draft = await seedProduct(hh, { status: "draft", name: "Road bike", categoryId: "177831", searchWords: ["rennrad"], mustWords: [["rennrad"]] });
    const csrf = formToken(await (await browser.get(`/products/${draft.key}`)).text());

    const response = await browser.post(`/products/${draft.key}/status`, { _csrf: csrf, version: String(draft.version), back: `/products/${draft.key}`, status: "active" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/products/${draft.key}`);
    const stored = await hh.db.admin.query("SELECT status, watch_from IS NOT NULL AS watched FROM app.product WHERE id = $1", [draft.id]);
    expect(stored.rows[0]).toEqual({ status: "active", watched: true });
    expect(primaryButtons(await (await browser.get(`/products/${draft.key}`)).text())).toEqual(["Edit product"]);
  });
});

describe("the market box", () => {
  it("opens the details with the design system's accordion trigger and chevron on a native <details> (ADR 0039)", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const tripod = await seedProduct(hh, { name: "Tripod", categoryId: "30090", searchWords: ["stativ"], mustWords: [["stativ"]] });
    await seedMarketValue(hh, tripod, { group: "used", status: "ok", valueCents: 9_000, computedAt: new Date(hh.clock.now().getTime() - DAY), n: 30, neff: 20 });

    const html = await (await browser.get(`/products/${tripod.key}`)).text();

    expect(html).toMatch(/<details class="ia-acc app-disclosure"><summary class="ia-acc__trigger"><span class="type-ui-label">Details<\/span><svg/);
  });

  it("draws the last 30 days of the typical asking price with its middle half per group (spec 6.5)", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const strobe = await seedProduct(hh, { name: "Strobe", categoryId: "30091", searchWords: ["strobe"], mustWords: [["strobe"]] });
    const daysAgo = (n: number) => new Date(hh.clock.now().getTime() - n * DAY);
    for (const [ago, valueCents] of [[40, 50_000], [3, 60_000], [2, 61_000], [1, 61_200]] as const) {
      await seedMarketValue(hh, strobe, { group: "used", status: "ok", valueCents, computedAt: daysAgo(ago), n: 30, neff: 20, p25Cents: valueCents - 5_000, p75Cents: valueCents + 5_000 });
    }

    const html = await (await browser.get(`/products/${strobe.key}`)).text();

    expect(html).toContain('<svg class="app-trend" viewBox="0 0 300 80" role="img" aria-label="Used: typical asking price over the last 30 days, from EUR 600 to EUR 612">');
    expect(html.match(/<circle class="app-trend__point"/g), "points of the last 30 days").toHaveLength(3);
    expect(html).toContain("<title>20 Oct 2026: EUR 612, middle half EUR 562 - EUR 662</title>");
  });

  it("shows per watched group the typical asking price, the limit, how sure, and the details", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const bike = await seedProduct(hh, {
      name: "Gravel bike",
      categoryId: "177831",
      searchWords: ["gravelbike"],
      mustWords: [["gravelbike"]],
      priceMode: "below_market",
      belowMarketPct: 15,
      maxCents: 70_000,
    });
    await seedMarketValue(hh, bike, {
      group: "used",
      status: "ok",
      valueCents: 61_200,
      computedAt: new Date(hh.clock.now().getTime() - DAY),
      n: 41,
      neff: 23,
      p25Cents: 56_000,
      p75Cents: 68_000,
      halfWidth: 0.06,
      bestOfferShare: 0.3,
      capped: true,
      counts: { too_cheap: 3, outlier: 1, unknown_shipping: 5, wrong_product: 2 },
    });

    const box = marketText(await (await browser.get(`/products/${bike.key}`)).text());

    expect(box).toContain("Used: typical asking price EUR 612 from 41 listings, 20 Oct 2026, 12:00 CEST");
    expect(box).toContain("Your limit for used EUR 520 15 % below, never above EUR 700");
    expect(box).toContain("How sure Reliable");
    // The reasons in the order spec 6.5 names them, whatever order the jsonb column keeps.
    expect(box).toContain("removed 3 too cheap, 1 outlier, 5 unknown shipping, 2 wrong product");
    expect(box).toContain(
      "Details Middle half EUR 560 - EUR 680; precision +/- 6 %; effective count 23; 30 % Best Offer; removed 3 too cheap, 1 outlier, 5 unknown shipping, 2 wrong product; newest listings only (snapshot capped)",
    );
    expect(box).toContain("Check market value About 1 eBay call");
  });

  it("says Checking while a check is open, hands market-poll.ts its URL and refreshes in 5 s without script", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    // A new product asks for its first snapshot (spec 6.6).
    const lens = await seedProduct(hh, { name: "Checking lens", categoryId: "3324", status: "draft" });

    const html = await (await browser.get(`/products/${lens.key}`)).text();

    expect(marketText(html)).toContain("Typical asking price Checking");
    expect(html).toContain(`aria-labelledby="market-title" data-market-poll="/products/${lens.key}/market"`);
    expect(html).toContain(`<noscript><meta http-equiv="refresh" content="5;url=/products/${lens.key}?auto=1"/></noscript>`);
  });

  it("names Rough, Not enough listings and Out of date, and says when the cap applies instead of a value", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const machine = await seedProduct(hh, {
      name: "Espresso machine",
      categoryId: "38252",
      conditionIds: ["1000", "2000", "3000"],
      searchWords: ["siebträger"],
      mustWords: [["siebträger"]],
      priceMode: "below_market",
      belowMarketPct: 20,
      maxCents: 100_000,
    });
    const at = (hours: number) => new Date(hh.clock.now().getTime() - hours * 3_600_000);
    await seedMarketValue(hh, machine, { group: "new", status: "none", valueCents: 80_000, computedAt: at(2), n: 3, neff: 3 });
    await seedMarketValue(hh, machine, { group: "refurbished", status: "ok", valueCents: 60_000, computedAt: at(50) });
    await seedMarketValue(hh, machine, { group: "used", status: "rough", valueCents: 50_000, computedAt: at(2) });

    const box = marketText(await (await browser.get(`/products/${machine.key}`)).text());

    expect(box).toContain("Your limit for new EUR 1,000 using your cap How sure Not enough listings");
    // An ok value 50 h old is out of date and still gives the limit (spec 6.4).
    expect(box).toContain("Your limit for refurbished EUR 480 20 % below, never above EUR 1,000 How sure Out of date");
    expect(box).toContain("Your limit for used EUR 1,000 using your cap How sure Rough");
  });

  it("puts a fixed max next to the typical asking price as a share of it", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Fixed lens", categoryId: "3326", maxCents: 48_000, status: "draft" });
    await seedMarketValue(hh, lens, { group: "used", status: "ok", valueCents: 61_000, computedAt: new Date(hh.clock.now().getTime() - 3_600_000) });

    const box = marketText(await (await browser.get(`/products/${lens.key}`)).text());

    expect(box).toContain("Your limit for used EUR 480 your max is 79 % of the typical asking price");
  });

  it("says when the last check did not run and that the last value is kept", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Refused lens", categoryId: "3327", status: "draft" });
    const at = (hours: number) => new Date(hh.clock.now().getTime() - hours * 3_600_000);
    await seedMarketValue(hh, lens, { group: "used", status: "ok", valueCents: 61_000, computedAt: at(48) });
    await hh.db.admin.query("UPDATE app.market_request SET status = 'refused', done_at = $2 WHERE product_id = $1", [lens.id, at(1)]);
    await hh.db.admin.query(
      "INSERT INTO app.market_run (product_id, started_at, finished_at, status) VALUES ($1, $2, $2, 'quota_refused')",
      [lens.id, at(1)],
    );

    const box = marketText(await (await browser.get(`/products/${lens.key}`)).text());

    expect(box).toContain("The eBay check did not run (daily budget reached). The last value from 19 Oct 2026 is kept.");
  });
});

type PreviewSeed = { legacyItemId: string; title: string; landedCents: number | null; outcome: string; group?: string };

async function seedPreview(hh: Harness, productId: string, rows: PreviewSeed[], seenAt: Date): Promise<void> {
  for (const row of rows) {
    await hh.db.admin.query(
      `INSERT INTO ebay_live.market_preview (product_id, item_key, legacy_item_id, title, landed_cents, condition_group, outcome, seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [productId, `k-${row.legacyItemId}`, row.legacyItemId, row.title, row.landedCents, row.outcome === "match" ? (row.group ?? "used") : null, row.outcome, seenAt],
    );
  }
}

const marketSection = (html: string): string => {
  const start = html.indexOf('<section id="market"');
  return html.slice(start, html.indexOf("</section>", start));
};

// A product whose newest check found a title with markup in it, and an accessory.
let hostile: Promise<{ html: string }> | undefined;

const hostilePage = () =>
  (hostile ??= (async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Hostile lens", categoryId: "3331", status: "draft" });
    await seedPreview(
      hh,
      lens.id,
      [
        { legacyItemId: "100000000009", title: `<img src=x onerror=alert(1)><a href="https://evil.example/">Canon 85mm</a>`, landedCents: 40_000, outcome: "match" },
        { legacyItemId: "100000000010", title: "Gegenlichtblende 85mm", landedCents: 2_000, outcome: "accessory" },
      ],
      new Date(hh.clock.now().getTime() - 3_600_000),
    );
    return { html: await (await browser.get(`/products/${lens.key}`)).text() };
  })());

describe("the listings of the newest check", () => {
  it("counts the listings found, those that match the rules and those under the limit", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Preview lens", categoryId: "3330", status: "draft" });
    await seedPreview(
      hh,
      lens.id,
      [
        { legacyItemId: "100000000001", title: "Canon EF 85mm f/1.8 USM", landedCents: 39_000, outcome: "match" },
        { legacyItemId: "100000000002", title: "Canon EF 85mm f/1.4L IS", landedCents: 89_000, outcome: "match" },
        { legacyItemId: "100000000003", title: "85mm Objektiv defekt", landedCents: 9_000, outcome: "excluded_word" },
        { legacyItemId: "100000000004", title: "Streulichtblende für 85mm", landedCents: 2_000, outcome: "accessory" },
      ],
      new Date(hh.clock.now().getTime() - 3_600_000),
    );

    const box = marketText(await (await browser.get(`/products/${lens.key}`)).text());

    expect(box).toContain("Of 4 listings found, 2 match your rules, 1 is under your limit.");
  });

  it("says matches and is for one listing, match and are for several", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const one = await seedProduct(hh, { name: "One lens", categoryId: "3332", status: "draft" });
    const three = await seedProduct(hh, { name: "Three lens", categoryId: "3333", status: "draft" });
    const seenAt = new Date(hh.clock.now().getTime() - 3_600_000);
    await seedPreview(hh, one.id, [{ legacyItemId: "100000000021", title: "Canon 85mm", landedCents: 50_000, outcome: "match" }], seenAt);
    await seedPreview(
      hh,
      three.id,
      ["31", "32", "33"].map((n) => ({ legacyItemId: `1000000000${n}`, title: `Canon 85mm ${n}`, landedCents: 30_000, outcome: "match" })),
      seenAt,
    );

    const [oneBox, threeBox] = await Promise.all([one, three].map(async (p) => marketText(await (await browser.get(`/products/${p.key}`)).text())));

    expect(oneBox).toContain("Of 1 listing found, 1 matches your rules, 0 are under your limit.");
    expect(threeBox).toContain("Of 3 listings found, 3 match your rules, 3 are under your limit.");
  });

  it("shows a hostile seller title as plain text", async () => {
    const { html } = await hostilePage();
    const section = marketSection(html);

    expect(section).not.toContain("<img");
    expect(section).not.toContain('href="https://evil.example/"');
    expect(section).toContain("&lt;img src=x onerror=alert(1)&gt;&lt;a href=&quot;https://evil.example/&quot;&gt;Canon 85mm&lt;/a&gt;");
  });

  it("links each title to its eBay item and to nothing else", async () => {
    const { html } = await hostilePage();

    expect([...marketSection(html).matchAll(/href="(https:[^"]*)"/g)].map((m) => m[1])).toEqual([
      "https://www.ebay.de/itm/100000000010",
      "https://www.ebay.de/itm/100000000009",
    ]);
  });

  it("says per title its price and whether it counted, or which rule dropped it", async () => {
    const { html } = await hostilePage();

    expect(marketText(html)).toContain("Gegenlichtblende 85mm EUR 20 Looks like an accessory (Accessory check)");
    expect(marketText(html)).toContain("Canon 85mm&lt;/a&gt; EUR 400 Counted");
  });
});

describe("POST /products/:key/market", () => {
  it("asks for a market check in the person's name and shows Checking", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Check-now lens", categoryId: "3328", status: "draft" });
    await hh.db.admin.query("UPDATE app.market_request SET status = 'done', done_at = $2 WHERE product_id = $1", [lens.id, hh.clock.now()]);
    const csrf = formToken(await (await browser.get(`/products/${lens.key}`)).text());

    const response = await browser.post(`/products/${lens.key}/market`, { _csrf: csrf });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/products/${lens.key}`);
    const asked = await hh.db.admin.query(
      `SELECT r.reason, r.status, u.email FROM app.market_request r JOIN auth.app_user u ON u.id = r.requested_by
        WHERE r.product_id = $1 AND r.status = 'open'`,
      [lens.id],
    );
    expect(asked.rows).toEqual([{ reason: "check_now", status: "open", email: "anna@example.test" }]);
  });

  it("refuses a sixth check of the person on one Berlin day and says so", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Sixth lens", categoryId: "3329", status: "draft" });
    await hh.db.admin.query("UPDATE app.market_request SET status = 'done', done_at = $2 WHERE product_id = $1", [lens.id, hh.clock.now()]);
    await hh.db.admin.query(
      `INSERT INTO app.market_request (product_id, requested_by, reason, requested_at, status, done_at)
       SELECT $1, u.id, 'check_now', $2, 'done', $2 FROM auth.app_user u, generate_series(1, 5) WHERE u.email = 'anna@example.test'`,
      [lens.id, hh.clock.now()],
    );
    const csrf = formToken(await (await browser.get(`/products/${lens.key}`)).text());

    const response = await browser.post(`/products/${lens.key}/market`, { _csrf: csrf });

    expect(response.status).toBe(429);
    expect(marketText(await response.text())).toContain("You have used your 5 market checks for today. You can check again after midnight.");
    const open = await hh.db.admin.query("SELECT 1 FROM app.market_request WHERE product_id = $1 AND status = 'open'", [lens.id]);
    expect(open.rows).toEqual([]);
  });
});

describe("GET /products/:key/market", () => {
  it("tells market-poll.ts as JSON whether a market check of the product is still open", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    // A new product asks for its first snapshot (spec 6.6).
    const lens = await seedProduct(hh, { name: "Polled lens", categoryId: "3325", status: "draft" });
    const poll = () => browser.get(`/products/${lens.key}/market`, { "X-Auto-Refresh": "1", Accept: "application/json" });

    const first = await poll();
    expect(first.headers.get("content-type")).toContain("application/json");
    const asked = (await first.json()) as unknown;
    await hh.db.admin.query("UPDATE app.market_request SET status = 'done', done_at = $2 WHERE product_id = $1", [lens.id, hh.clock.now()]);
    const done = (await (await poll()).json()) as unknown;

    expect([asked, done]).toEqual([{ checking: true }, { checking: false }]);
  });
});

// Last in the file: it fills the plan and archives what it added afterwards.
describe("POST /products/:key/status over the plan", () => {
  it("keeps a draft that would take the plan over 2,500 and says why", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const fast = await Promise.all(
      ["4001", "4002", "4003", "4004", "4005"].map((categoryId) => seedProduct(hh, { status: "draft", name: `Fast ${categoryId}`, categoryId, speed: "fast" })),
    );
    const [last, ...others] = fast;
    if (last === undefined) throw new Error("no product seeded");
    await hh.db.admin.query("UPDATE app.product SET status = 'active' WHERE id = ANY($1::uuid[])", [others.map((p) => p.id)]);
    const csrf = formToken(await (await browser.get(`/products/${last.key}`)).text());

    const response = await browser.post(`/products/${last.key}/status`, { _csrf: csrf, version: String(last.version), back: `/products/${last.key}`, status: "active" });

    await hh.db.admin.query("UPDATE app.product SET status = 'archived' WHERE id = ANY($1::uuid[])", [fast.map((p) => p.id)]);
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/Not activated: with this product the plan would be [\d,]+ eBay calls a day, over the 2,500 planned\./);
  });
});
