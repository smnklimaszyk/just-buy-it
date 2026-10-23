import { saveProductWithPlan } from "@ebay-sniper/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, signIn, type Browser, type Harness } from "../../testing/harness.js";
import { itemKey, seedCandidate, seedProduct } from "./testing/products.js";

// Spec 8.3 /products/:key: the tabs Deals, Filtered out and History.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const HOUR = 3_600_000;

let editor: Promise<Browser> | undefined;

const signedInEditor = async () =>
  (editor ??= (async () => {
    const hh = await harness();
    await addPerson(hh, "anna@example.test", "editor");
    const browser = hh.browser();
    await signIn(hh, browser, "anna@example.test");
    return browser;
  })());

// The body rows of the page's table as text: tags out, spaces collapsed.
function rowTexts(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("the Deals tab", () => {
  it("lists the product's alerted, held and wrong-product candidates, newest first", async () => {
    const { html } = await dealsPage();

    expect(rowTexts(html).map((row) => row.split(" EUR")[0])).toEqual(["Canon EF 85mm f/1.8 USM", "Canon 85mm 1.8", "Gegenlichtblende ET-65 für 85mm"]);
  });

  it("shows each deal's price, its limit and what became of it", async () => {
    const { html } = await dealsPage();
    const [alerted, held, wrong] = rowTexts(html);

    expect(alerted).toContain("Canon EF 85mm f/1.8 USM EUR 390 EUR 450 Alerted");
    expect(held).toContain("Canon 85mm 1.8 EUR 400 Held");
    expect(wrong).toContain("Gegenlichtblende ET-65 für 85mm EUR 15 Wrong product");
  });

  it("gives Claude's reason, or why a deal is held, and when it came in", async () => {
    const { html } = await dealsPage();
    const [alerted, held, wrong] = rowTexts(html);

    expect(alerted).toContain("Alerted Lens with both caps, no faults named. 1 h ago");
    expect(held).toContain("Held Claude unavailable 2 h ago");
    expect(wrong).toContain("Wrong product A lens hood, not a lens. 3 h ago");
  });

  it("filters the deals by what became of them", async () => {
    const { key } = await dealsPage();
    const browser = await signedInEditor();

    const held = await (await browser.get(`/products/${key}/deals?show=held`)).text();

    expect(rowTexts(held).map((row) => row.split(" EUR")[0])).toEqual(["Canon 85mm 1.8"]);
  });

  it("shows a hostile seller title as text, linked only to its eBay item", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Hostile deals lens", categoryId: "3325", status: "draft" });
    await seedCandidate(hh, lens, {
      decision: "alerted",
      createdAt: new Date(hh.clock.now().getTime() - HOUR),
      legacyItemId: "300000000009",
      title: `<script>alert(1)</script><a href="https://evil.example/">Canon 85mm</a>`,
      claudeReason: `<img src=x onerror=alert(2)>`,
    });

    const html = await (await browser.get(`/products/${lens.key}/deals`)).text();
    const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));

    expect(body).not.toContain("<script");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;a href=&quot;https://evil.example/&quot;&gt;Canon 85mm&lt;/a&gt;");
    expect(body).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect([...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["https://www.ebay.de/itm/300000000009"]);
  });

  it("says a deal's title is deleted once its content is older than 6 hours, and links nothing", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Old deals lens", categoryId: "3331", status: "draft" });
    await seedCandidate(hh, lens, { decision: "alerted", createdAt: new Date(hh.clock.now().getTime() - 7 * HOUR), legacyItemId: "300000000011", title: "Expired title" });

    const html = await (await browser.get(`/products/${lens.key}/deals`)).text();
    const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));

    expect(rowTexts(html)[0]).toContain("Title deleted after 6 hours");
    expect(body).not.toContain("Expired title");
    expect(body).not.toContain("href=");
  });

  it("offers the filters as links and marks the chosen one", async () => {
    const { key } = await dealsPage();
    const browser = await signedInEditor();

    const page = await (await browser.get(`/products/${key}/deals?show=held`)).text();
    const nav = page.indexOf('aria-label="Filter deals"');
    const held = nav < 0 ? "" : page.slice(nav, page.indexOf("</nav>", nav));
    const filters = [...held.matchAll(/<a href="(\/products\/[^"]+\/deals[^"]*)"( aria-current="page")?[^>]*>([^<]+)</g)].map((m) => [m[1], m[3], m[2] !== undefined]);

    expect(filters).toEqual([
      [`/products/${key}/deals`, "All", false],
      [`/products/${key}/deals?show=alerted`, "Alerted", false],
      [`/products/${key}/deals?show=held`, "Held", true],
      [`/products/${key}/deals?show=wrong_product`, "Wrong product", false],
    ]);
  });
});

describe("the Filtered out tab", () => {
  it("counts the product's filtered listings by reason for the last 24 hours and 7 days", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Filtered lens", categoryId: "3326", status: "draft" });
    const seen = async (outcome: string, hoursAgo: number, segment = lens.key) => {
      const at = new Date(hh.clock.now().getTime() - hoursAgo * HOUR);
      await hh.db.admin.query(
        "INSERT INTO app.seen_item (item_key, key_version, feed_id, segment, outcome, first_seen_at, last_seen_at) VALUES ($1, 1, 's1', $2, $3, $4, $4)",
        [itemKey(), segment, outcome, at],
      );
    };
    await seen("accessory", 1);
    await seen("accessory", 30);
    await seen("excluded_word", 2);
    await seen("excluded_word", 3);
    await seen("defective", 100);
    await seen("defective", 200);
    await seen("candidate", 1);
    await seen("accessory", 1, "p_other");

    const response = await browser.get(`/products/${lens.key}/filtered`);

    expect(response.status).toBe(200);
    expect(rowTexts(await response.text())).toEqual([
      "Has a word you excluded Must not contain 2 2",
      "Looks like an accessory Accessory check 1 2",
      "For parts or not working Junk rule 0 1",
    ]);
  });

  it("lists the titles filtered out in the last 6 hours with the rule that fired, as plain text", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Sample lens", categoryId: "3327", status: "draft" });
    const sample = (title: string, reason: string, hoursAgo: number, segment = lens.key) => {
      const at = new Date(hh.clock.now().getTime() - hoursAgo * HOUR);
      return hh.db.admin.query(
        `INSERT INTO ebay_live.classifier_sample (feed_id, segment, title, landed_cents, outcome, reason, seen_at, expires_at)
         VALUES ('s1', $1, $2, 2000, 'rejected', $3, $4, $4::timestamptz + interval '6 hours')`,
        [segment, title, reason, at],
      );
    };
    await sample("Gegenlichtblende 85mm", "accessory", 1);
    await sample(`<b onmouseover=alert(1)>85mm defekt</b>`, "excluded_word", 2);
    await sample("Older title", "accessory", 7);
    await sample("Other product's title", "accessory", 1, "p_other");

    const html = await (await browser.get(`/products/${lens.key}/filtered`)).text();
    const titles = html.slice(html.indexOf("Titles of the last 6 hours"));

    expect(rowTexts(titles)).toEqual([
      "Gegenlichtblende 85mm EUR 20 Looks like an accessory (Accessory check) 1 h ago",
      "&lt;b onmouseover=alert(1)&gt;85mm defekt&lt;/b&gt; EUR 20 Has a word you excluded (Must not contain) 2 h ago",
    ]);
    expect(titles).not.toContain("<b onmouseover");
  });
});

describe("the History tab", () => {
  it("lists the revisions newest first with who made them, when, and what changed", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "History lens", categoryId: "3328", status: "draft" });
    const anna = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'anna@example.test'");
    const annaId = anna.rows[0]?.id ?? "";
    const saved = await saveProductWithPlan(
      hh.db.admin,
      { kind: "update", id: lens.id, version: lens.version, fields: { ...lens.rules, name: "History lens II", maxCents: 50_000 } },
      { at: new Date(hh.clock.now().getTime() + 5 * 60_000), actor: `user:${annaId}`, userId: annaId, env: hh.deps.settingsEnv },
    );
    expect(saved.ok).toBe(true);

    const response = await browser.get(`/products/${lens.key}/history`);

    expect(response.status).toBe(200);
    expect(rowTexts(await response.text())).toEqual([
      "2 anna@example.test 21 Oct 2026, 12:05 CEST Name: was History lens, now History lens II Max price (EUR): was 450, now 500",
      "1 Command line 21 Oct 2026, 12:00 CEST Created",
    ]);
  });

  it("names a status change, which the form fields do not show", async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Status lens", categoryId: "3330", status: "draft" });
    const csrf = formToken(await (await browser.get(`/products/${lens.key}`)).text());
    await browser.post(`/products/${lens.key}/status`, { _csrf: csrf, version: String(lens.version), back: `/products/${lens.key}`, status: "paused" });

    const rows = rowTexts(await (await browser.get(`/products/${lens.key}/history`)).text());

    expect(rows[0]).toBe("2 anna@example.test 21 Oct 2026, 12:00 CEST Status: was Draft, now Paused");
  });
});

// One product with an alerted, a held and a wrong-product candidate, a pending one, and another
// product's deal.
let deals: Promise<{ html: string; status: number; key: string }> | undefined;

const dealsPage = () =>
  (deals ??= (async () => {
    const browser = await signedInEditor();
    const hh = await harness();
    const lens = await seedProduct(hh, { name: "Deals lens", status: "draft" });
    const other = await seedProduct(hh, { name: "Other lens", categoryId: "3324", status: "draft" });
    const ago = (hours: number) => new Date(hh.clock.now().getTime() - hours * HOUR);
    await seedCandidate(hh, lens, {
      decision: "alerted",
      createdAt: ago(1),
      legacyItemId: "300000000001",
      title: "Canon EF 85mm f/1.8 USM",
      landedCents: 39_000,
      limitCents: 45_000,
      claudeReason: "Lens with both caps, no faults named.",
    });
    await seedCandidate(hh, lens, { decision: "held", createdAt: ago(2), legacyItemId: "300000000002", title: "Canon 85mm 1.8", heldReason: "claude_unavailable" });
    await seedCandidate(hh, lens, {
      decision: "wrong_product",
      createdAt: ago(3),
      legacyItemId: "300000000003",
      title: "Gegenlichtblende ET-65 für 85mm",
      landedCents: 1_500,
      claudeReason: "A lens hood, not a lens.",
      productMatch: "mismatch",
    });
    await seedCandidate(hh, lens, { decision: "pending", createdAt: ago(4), legacyItemId: "300000000004", title: "Canon 85mm pending" });
    await seedCandidate(hh, other, { decision: "alerted", createdAt: ago(1), legacyItemId: "300000000005", title: "Other product's deal" });

    const response = await browser.get(`/products/${lens.key}/deals`);
    return { html: await response.text(), status: response.status, key: lens.key };
  })());
