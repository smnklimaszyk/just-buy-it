import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, signIn, START, type Browser, type Harness } from "../../testing/harness.js";
import { seedAlert, seedCandidate, seedMarketValue, seedProduct } from "../products/testing/products.js";

// Spec 8.3 /: the open deals of the last 24 hours first, then today's figures, the worker and
// searches, and the platform banners.

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

// Every test starts without products, candidates or platform rows.
beforeEach(async () => {
  const { hh } = await signedIn();
  hh.clock.set(START);
  await hh.db.admin.query(`TRUNCATE app.alert, app.candidate, app.screening, ebay_live.screening_text, ebay_live.listing_content,
    ebay_live.listing, app.market_value, app.product_revision, app.search_product, app.search, app.product_source, app.product,
    app.poll_run, app.api_usage_hourly, app.ebay_quota_window, app.llm_usage_daily, app.worker_status, app.screening_pause,
    app.smtp_pause, app.setting CASCADE`);
});

const minutesAgo = (hh: Harness, n: number): Date => new Date(hh.clock.now().getTime() - n * 60_000);

// The text of each cell of the table row whose row header reads `first`.
function cells(html: string, first: string): string[] {
  const at = html.indexOf(`>${first}</th>`);
  if (at < 0) throw new Error(`no row ${first}`);
  const start = html.lastIndexOf("<tr>", at);
  const row = html.slice(start, html.indexOf("</tr>", start));
  return [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("GET /", () => {
  it("leads with the open deals of the last 24 hours: product, price, the limit it passed, Claude's verdict and the eBay link", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    const fresh = await seedCandidate(hh, lens, {
      decision: "alerted",
      createdAt: minutesAgo(hh, 30),
      title: "Canon EF 85mm f/1.8",
      legacyItemId: "123456789012",
      landedCents: 40_000,
      limitCents: 50_000,
    });
    await seedAlert(hh, lens, fresh, minutesAgo(hh, 30));
    const old = await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 25 * 60), title: "Yesterday's lens", limitCents: 50_000 });
    await seedAlert(hh, lens, old, minutesAgo(hh, 25 * 60));

    const response = await browser.get("/");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Overview - Just-Buy-It</title>");
    expect(cells(html, "Portrait lens")).toEqual([
      "Portrait lens",
      "Canon EF 85mm f/1.8",
      "EUR 400",
      "EUR 500 80 % of limit",
      "Fixed max price",
      "Passed",
      "30 min ago",
      "Open on eBay (opens in a new tab)",
    ]);
    expect(html).toContain('href="https://www.ebay.de/itm/123456789012"');
    expect(html).not.toContain("Yesterday's lens");
  });

  it("labels a deal by its product's name, and by the key when no product has the key", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    await seedAlert(hh, lens, await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 10), limitCents: 50_000 }), minutesAgo(hh, 10));
    // A Release 0 row of a segment the import did not bring over.
    const orphan = await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 20), title: "Graphics card" });
    await hh.db.admin.query("UPDATE app.candidate SET segment = 'gpu_3090', product_version = NULL WHERE id = $1", [orphan]);
    await seedAlert(hh, lens, orphan, minutesAgo(hh, 20));

    const html = await (await browser.get("/")).text();

    expect(cells(html, "gpu_3090").slice(0, 2)).toEqual(["gpu_3090", "Graphics card"]);
    expect(cells(html, "Portrait lens")[0]).toBe("Portrait lens");
  });

  it("gives the market line in market mode: how far below the typical asking price, or 'using your cap' without a usable value", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh, { name: "Market lens", priceMode: "below_market", belowMarketPct: 20, maxCents: 60_000 });
    const value = await seedMarketValue(hh, lens, { group: "used", status: "ok", valueCents: 55_000, computedAt: minutesAgo(hh, 600) });
    const market = await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 10), landedCents: 41_250, limitCents: 44_000 });
    const cap = await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 20), landedCents: 54_000, limitCents: 60_000 });
    await hh.db.admin.query("UPDATE app.candidate SET price_mode = 'below_market', market_value_id = $2 WHERE id = $1", [market, value]);
    await hh.db.admin.query("UPDATE app.candidate SET price_mode = 'below_market' WHERE id = $1", [cap]);
    await seedAlert(hh, lens, market, minutesAgo(hh, 10));
    await seedAlert(hh, lens, cap, minutesAgo(hh, 20));

    const html = await (await browser.get("/")).text();

    const [first, second] = [...html.matchAll(/<th scope="row"[^>]*>Market lens<\/th>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
    expect(first).toContain("25 % below the typical asking price of EUR 550");
    expect(first).toContain("94 % of limit");
    expect(second).toContain("EUR 600, using your cap");
    expect(second).toContain("No reliable market value");
  });

  it("shows Claude's verdict as a Badge, 'Not checked by Claude' when it could not check, and Claude's reason", async () => {
    const { hh, browser } = await signedIn();
    const verdicts: [string, string, boolean][] = [
      ["Caution lens", "caution", true],
      ["Unchecked lens", "pass", false],
    ];
    for (const [index, [title, verdict, screened]] of verdicts.entries()) {
      const lens = await seedProduct(hh, { name: title });
      const id = await seedCandidate(hh, lens, {
        decision: "alerted",
        createdAt: minutesAgo(hh, 10 + index),
        limitCents: 50_000,
        ...(screened ? { claudeReason: "The seller joined last week.", verdict: "caution" as const } : {}),
      });
      await seedAlert(hh, lens, id, minutesAgo(hh, 10 + index));
      await hh.db.admin.query("UPDATE app.alert SET final_verdict = $2, screened = $3 WHERE candidate_id = $1", [id, verdict, screened]);
    }

    const html = await (await browser.get("/")).text();

    expect(cells(html, "Caution lens")[5]).toBe("Caution The seller joined last week.");
    expect(html).toMatch(/ia-badge--warning[^>]*>[\s\S]*?Caution<\/span>/);
    expect(cells(html, "Unchecked lens")[5]).toBe("Not checked by Claude");
  });

  it("measures a row without candidate.limit_cents against the product revision it passed", async () => {
    const { hh, browser } = await signedIn();
    // Revision 1 holds the max price of EUR 450; the product is now at EUR 900.
    const lens = await seedProduct(hh);
    await hh.db.admin.query("UPDATE app.product SET max_cents = 90000, version = 2 WHERE id = $1", [lens.id]);
    const id = await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 10), landedCents: 40_000 });
    await seedAlert(hh, lens, id, minutesAgo(hh, 10));

    const html = await (await browser.get("/")).text();

    expect(cells(html, "Portrait lens")[3]).toBe("EUR 450 89 % of limit");
  });

  it("says so when there is no open deal", async () => {
    const { browser } = await signedIn();

    const html = await (await browser.get("/")).text();

    expect(html).toContain("No deals in the last 24 hours.");
    // Not a cell of a table in a sideways scroll box, where a phone cuts the sentence off.
    expect(html).not.toContain('<caption class="ia-sr">Open deals of the last 24 hours</caption>');
  });

  it("then shows today's figures as StatTiles and the eBay quota and Claude caps as Meters", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    const deal = await seedCandidate(hh, lens, { decision: "alerted", createdAt: minutesAgo(hh, 10), limitCents: 50_000 });
    await seedAlert(hh, lens, deal, minutesAgo(hh, 10));
    await seedCandidate(hh, lens, { decision: "held", createdAt: minutesAgo(hh, 20) });
    await hh.db.admin.query(
      "INSERT INTO app.api_usage_hourly (hour_utc, resource, purpose, calls) VALUES ('2026-10-21T08:00:00Z', 'buy.browse', 'poll', 37), ('2026-10-21T09:00:00Z', 'buy.browse', 'get_item', 4)",
    );
    const now = hh.clock.now().getTime();
    await hh.db.admin.query(
      `INSERT INTO app.ebay_quota_window (resource, window_start, window_end, used, used_standard, used_alert_path)
       VALUES ('buy.browse', $1, $2, 1234, 1200, 34)`,
      [new Date(now - 3_600_000), new Date(now + 20 * 3_600_000)],
    );
    await hh.db.admin.query("INSERT INTO app.llm_usage_daily (day_berlin, calls, reserved_microusd, spent_microusd) VALUES ('2026-10-21', 12, 0, 420000)");

    const html = await (await browser.get("/")).text();

    const tile = (label: string) => new RegExp(`${label}</p><p class="ia-stat__value"><span[^>]*>([^<]*)</span>`).exec(html)?.[1];
    expect(tile("Deals today")).toBe("1");
    expect(tile("Candidates today")).toBe("2");
    expect(tile("eBay calls today")).toBe("41");
    expect(tile("Claude spend today")).toBe("$0.42");
    expect(html).toMatch(/<meter min="0" max="4000" value="1234"/);
    expect(html).toMatch(/<meter min="0" max="40" value="12"/);
    expect(html).toMatch(/<meter min="0" max="2000000" value="420000"/);
    expect(html).toContain("$0.42 / $2.00");
    // The deals come first.
    expect(html.indexOf("Open deals")).toBeLessThan(html.indexOf("Deals today"));
  });

  it("shows the worker and each live search as a StatusDot with a word", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    const search = await hh.db.admin.query<{ id: string }>("SELECT id FROM app.search WHERE retired_at IS NULL");
    const id = search.rows[0]?.id ?? "";
    await hh.db.admin.query("INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status) VALUES ($1, 'poll', $2, $2, 'error')", [
      id,
      minutesAgo(hh, 3),
    ]);
    await hh.db.admin.query(
      "INSERT INTO app.worker_status (id, git_sha, started_at, heartbeat_at, smtp_configured, claude_configured) VALUES (1, 'abc', $1, $2, true, true)",
      [minutesAgo(hh, 60), minutesAgo(hh, 0.5)],
    );

    const running = await (await browser.get("/")).text();
    hh.clock.advance(5 * 60_000);
    const stopped = await (await browser.get("/")).text();

    const dot = (html: string, text: string) => new RegExp(`ia-dot--(\\w+)[^>]*></span>${text}`).exec(html)?.[1];
    expect(dot(running, "Worker running")).toBe("success");
    expect(dot(running, `${id} \\(${lens.rules.name}\\): last poll failed 3 min ago`)).toBe("danger");
    expect(dot(stopped, "Worker not reporting, last heartbeat 5 min ago")).toBe("danger");
  });

  it("puts platform state in Banners: paused Claude checks and emails, a stored cap above its ceiling, a Claude cap used up", async () => {
    const { hh, browser } = await signedIn();
    await hh.db.admin.query("INSERT INTO app.screening_pause (id, until) VALUES (1, $1)", [new Date(hh.clock.now().getTime() + 15 * 60_000)]);
    await hh.db.admin.query("INSERT INTO app.smtp_pause (id, until) VALUES (1, $1)", [new Date(hh.clock.now().getTime() + 30 * 60_000)]);
    await hh.db.admin.query(`INSERT INTO app.setting (key, value) VALUES ('claude.daily_spend_limit_usd', '"8.00"')`);
    await hh.db.admin.query("INSERT INTO app.llm_usage_daily (day_berlin, calls, reserved_microusd, spent_microusd) VALUES ('2026-10-21', 40, 0, 900000)");

    const html = await (await browser.get("/")).text();

    const banners = [...html.matchAll(/<div class="ia-banner ia-banner--(\w+)"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => [
      m[1],
      // The page escapes quotes as entities; the test reads them back as text.
      (m[2] ?? "")
        .replace(/<[^>]+>/g, "")
        .replaceAll("&#39;", "'")
        .replaceAll("&quot;", '"')
        .trim(),
    ]);
    expect(banners).toEqual([
      ["warning", "Stored Claude spend cap $8.00 is above the server ceiling $2.00; $2.00 applies."],
      ["warning", "Claude checks are paused until 12:15 CEST."],
      ["warning", "Alert emails are paused until 12:30 CEST. They go out when the pause ends."],
      ["info", "Today's 40 Claude checks are used up. Until midnight alerts say \"Not checked by Claude\", and products that require the check hold them."],
    ]);
  });

  it("refreshes itself every 60 seconds as an automatic request", async () => {
    const { browser } = await signedIn();

    const html = await (await browser.get("/")).text();
    const auto = await browser.get("/?auto=1");

    expect(html).toContain('<meta http-equiv="refresh" content="60;url=/?auto=1"/>');
    expect(auto.status).toBe(200);
  });

  it("says the Claude check is off instead of drawing Meters against a cap of 0", async () => {
    const { hh, browser } = await signedIn();
    await hh.db.admin.query(`INSERT INTO app.setting (key, value) VALUES ('claude.daily_call_limit', '0'), ('claude.daily_spend_limit_usd', '"0"')`);

    const html = await (await browser.get("/")).text();

    expect(html).not.toMatch(/<meter min="0" max="0"/);
    expect(html).toContain("The Claude check is off: the daily call limit is 0.");
  });

  it("says when the Claude spend cap is used up before the call cap", async () => {
    const { hh, browser } = await signedIn();
    await hh.db.admin.query("INSERT INTO app.llm_usage_daily (day_berlin, calls, reserved_microusd, spent_microusd) VALUES ('2026-10-21', 7, 0, 2000000)");

    const html = await (await browser.get("/")).text();

    expect(html).toContain("Today&#39;s Claude spend cap of $2.00 is used up.");
    expect(html).not.toContain("Claude checks are used up");
  });

  it("writes a hostile seller title as text", async () => {
    const { hh, browser } = await signedIn();
    const lens = await seedProduct(hh);
    const id = await seedCandidate(hh, lens, {
      decision: "alerted",
      createdAt: minutesAgo(hh, 5),
      title: '<script>alert(1)</script><img src=x onerror="alert(2)">',
      limitCents: 50_000,
    });
    await seedAlert(hh, lens, id, minutesAgo(hh, 5));

    const html = await (await browser.get("/")).text();

    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
