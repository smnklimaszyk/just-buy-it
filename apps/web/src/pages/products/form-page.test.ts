import { saveProductWithPlan } from "@ebay-sniper/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, signIn, START, type Browser, type Harness } from "../../testing/harness.js";
import { seedMarketValue, seedProduct } from "./testing/products.js";

// Spec 8.4: the product form, new and edit, with its cost and market boxes.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const primaryButtons = (html: string): string[] => [...html.matchAll(/class="ia-btn [^"]*ia-btn--primary[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span class="ia-btn__label">([^<]*)</g)].map((m) => m[1] ?? "");

// The form as a person fills it in for the lens of testing/products.ts.
const LENS_FORM = {
  name: "Portrait lens",
  description: "Used 85 mm portrait lens for Canon EF. Not a lens hood, not a teleconverter.",
  searchWords: "85mm, portraitobjektiv",
  mustWords: "",
  excludeWords: "defekt*",
  categoryId: "3323",
  conditionGroups: "used",
  conditionIds: "",
  priceMode: "fixed",
  maxPrice: "450",
  belowMarketPct: "",
  speed: "normal",
  floor: "",
  readCeiling: "",
  unitMinTotal: "",
  unitMaxTotal: "",
  warnWords: "",
  useDefaultJunk: "on",
  accessoryCheck: "on",
  candidateCapPerDay: "10",
  buyerProfile: "company",
  testTitle: "",
};

// The cost box: from its hook to the market box after it.
const costBox = (html: string): string => html.slice(html.indexOf("data-cost-result"), html.indexOf("Typical asking price", html.indexOf("data-cost-result")));

// The field names of the form that posts to `action`, each once, in page order. From the start
// of a slice inside the form, the form's own start is not needed.
function fieldNames(html: string, action: string): string[] {
  const start = html.indexOf(`action="${action}"`);
  const form = html.slice(start === -1 ? 0 : start, html.indexOf("</form>", start === -1 ? 0 : start));
  return [...new Set([...form.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1] ?? ""))];
}

let editor: Promise<{ browser: Browser; id: string }> | undefined;

// An editor: editors add and edit products like admins (spec 7.7).
const signedInEditor = async () =>
  (editor ??= (async () => {
    const hh = await harness();
    const id = await addPerson(hh, "anna@example.test", "editor");
    const browser = hh.browser();
    await signIn(hh, browser, "anna@example.test");
    return { browser, id };
  })());

describe("GET /products/new", () => {
  it("shows the core fields, the Advanced block closed, Save draft as the one primary and the market hint", async () => {
    const { browser } = await signedInEditor();

    const response = await browser.get("/products/new");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Add product - Just-Buy-It</title>");
    // Every field of spec 8.4 in page order: the core fields, then the Advanced block (from speed).
    expect(fieldNames(html, "/products/new")).toEqual([
      "_csrf",
      "name",
      "description",
      "searchWords",
      "mustWords",
      "excludeWords",
      "categoryId",
      // Suggest category; Test title, Save draft and Check cost post the same name.
      "intent",
      "conditionGroups",
      "priceMode",
      "maxPrice",
      "belowMarketPct",
      "alertRecipientIds",
      "speed",
      "priceDropCheck",
      "floor",
      "readCeiling",
      "perGb",
      "unitMinTotal",
      "unitMaxTotal",
      "warnWords",
      "useDefaultJunk",
      "junkExceptions",
      "accessoryCheck",
      "candidateCapPerDay",
      "buyerProfile",
      "claudeRequired",
      "conditionIds",
      "testTitle",
    ]);
    // The design system's accordion on a native <details>: its trigger, title and chevron (ADR 0039).
    expect(html).toMatch(
      /<details class="ia-acc app-disclosure"><summary class="ia-acc__trigger"><span class="type-title-sm">Advanced matching and alerts<\/span><svg[^>]*class="ia-icon ia-acc__chev"/,
    );
    expect(fieldNames(html.slice(html.indexOf('<details class="ia-acc')), "/products/new")[0]).toBe("speed");
    expect(primaryButtons(html)).toEqual(["Save draft"]);
    expect(html).toMatch(/<button type="submit" name="intent" value="cost" data-cost-check=""[^>]*class="ia-btn [^"]*ia-btn--secondary/);
    expect(html).toContain('<a href="/products" class="ia-link">Cancel</a>');
    expect(html).toContain("Save the draft to see the typical asking price. This uses about 1 eBay call.");
  });

  it("shows the price fields of the checked price rule only, by CSS, so it follows a click without script", async () => {
    const { browser } = await signedInEditor();

    const html = await (await browser.get("/products/new")).text();

    expect(html).toContain('<div class="app-price-rule app-stack">');
    expect(html).toContain('<span class="app-when-fixed">Max price (EUR)</span><span class="app-when-market">Never above (EUR)</span>');
    expect(html).toMatch(/<div class="app-when-market"><div class="ia-field"><div class="ia-field__top"><label[^>]*for="product-belowMarketPct"/);
  });

  it("starts the plan Meter at the plan of today's products, not at 0, before Check cost runs", async () => {
    const { browser } = await signedInEditor();

    const html = await (await browser.get("/products/new")).text();

    // No product yet: getItem for 40 Claude calls (126) and the market line's 60.
    expect(html).toMatch(/<meter min="0" max="2500" value="186"/);
  });

  it("says what the buyer profile changes as Settings does: prices are compared gross either way", async () => {
    const { browser } = await signedInEditor();

    const html = await (await browser.get("/products/new")).text();

    expect(html).toContain("The alert says whether the seller gives a VAT invoice.");
    expect(html).toContain("The alert leaves VAT out. Prices are compared gross either way.");
    expect(html).not.toContain("without VAT");
  });
});

describe("POST /products/new", () => {
  it("saves a draft as the editor and opens the new product's page", async () => {
    const { browser, id } = await signedInEditor();
    const csrf = formToken(await (await browser.get("/products/new")).text());

    const response = await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, alertRecipientIds: id, intent: "save" });

    expect(response.status).toBe(303);
    const key = /^\/products\/(p_[a-z2-7]{10})$/.exec(response.headers.get("location") ?? "")?.[1];
    expect(key).toBeDefined();
    const hh = await harness();
    const stored = await hh.db.admin.query(
      "SELECT name, status, created_by::text AS created_by, max_cents, search_words, alert_recipient_ids::text[] AS recipients FROM app.product WHERE key = $1",
      [key],
    );
    expect(stored.rows[0]).toEqual({
      name: "Portrait lens",
      status: "draft",
      created_by: id,
      max_cents: 45_000,
      search_words: ["85mm", "portraitobjektiv"],
      recipients: [id],
    });
    const audit = await hh.db.admin.query("SELECT actor FROM app.audit_event WHERE action = 'product.created'");
    expect(audit.rows).toEqual([{ actor: `user:${id}` }]);
  });

  it("refuses bad fields and word grammar with a message on each field, a summary with links, and keeps what was typed", async () => {
    const { browser } = await signedInEditor();
    const csrf = formToken(await (await browser.get("/products/new")).text());
    const hh = await harness();
    const before = await hh.db.admin.query("SELECT count(*)::int AS n FROM app.product");

    const response = await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, name: "", excludeWords: "ok, (a+)+$", maxPrice: "abc", intent: "save" });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("3 fields need attention");
    expect(html).toMatch(/<a href="#product-name" class="ia-link">Name<\/a>/);
    expect(html).toMatch(/<a href="#product-excludeWords" class="ia-link">Must not contain<\/a>/);
    expect(html).toMatch(/<a href="#product-maxPrice" class="ia-link">Max price \(EUR\)<\/a>/);
    expect(html).toMatch(/<input [^>]*id="product-name"[^>]*aria-describedby="product-name-err"[^>]*aria-invalid="true"/);
    expect(html).toContain('id="product-excludeWords-err"><svg');
    expect(html).toContain("“(a+)+$”:");
    expect(html).toContain("Enter an amount in euros, for example 550 or 2.10.");
    expect(html).toContain('value="ok, (a+)+$"');
    expect(html).toContain(">Used 85 mm portrait lens for Canon EF. Not a lens hood, not a teleconverter.</textarea>");
    expect((await hh.db.admin.query("SELECT count(*)::int AS n FROM app.product")).rows).toEqual(before.rows);
  });

  it("shows the cost of the product once active without saving when Check cost is posted without script", async () => {
    const { browser } = await signedInEditor();
    const csrf = formToken(await (await browser.get("/products/new")).text());
    const hh = await harness();
    const before = await hh.db.admin.query("SELECT count(*)::int AS n FROM app.product");

    const response = await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, categoryId: "179", intent: "cost" });

    expect(response.status).toBe(200);
    const html = await response.text();
    const box = costBox(html);
    expect(box).toContain("ia-callout--info");
    expect(box).toContain("When active: +253 calls a day (new search for category 179 at normal speed).");
    expect(box).toMatch(/Total once active [\d,]+ of 2,500, [\d,]+ left\./);
    expect(box).toContain('<meter min="0" max="2500"');
    expect(html).toContain('value="179"');
    expect((await hh.db.admin.query("SELECT count(*)::int AS n FROM app.product")).rows).toEqual(before.rows);
  });
});

describe("POST /products/new/cost", () => {
  it("answers cost-preview.ts with the same lines as JSON, for the form's data-cost-preview URL", async () => {
    const { browser } = await signedInEditor();
    const html = await (await browser.get("/products/new")).text();
    const csrf = formToken(html);
    expect(html).toContain('data-cost-preview="/products/new/cost"');

    const response = await browser.post("/products/new/cost", { ...LENS_FORM, _csrf: csrf, categoryId: "179" }, { Accept: "application/json", "X-CSRF-Token": csrf });

    expect(response.status).toBe(200);
    const reply = (await response.json()) as { tone: string; lines: string[]; meter: { value: number; max: number } };
    expect(reply.tone).toBe("info");
    expect(reply.lines[0]).toBe("When active: +253 calls a day (new search for category 179 at normal speed).");
    expect(reply.meter.max).toBe(2_500);
  });
});

describe("/products/:key/edit", () => {
  it("shows the product's typical asking price and limit per watched group beside the form (spec 6.5)", async () => {
    const { browser } = await signedInEditor();
    const hh = await harness();
    const product = await seedProduct(hh, {
      name: "Studio flash",
      // A draft has no search, so the plan numbers of the tests below stay as they are.
      status: "draft",
      categoryId: "48515",
      searchWords: ["blitz"],
      mustWords: [["blitz"]],
      priceMode: "below_market",
      belowMarketPct: 15,
      maxCents: 100_000,
    });
    await seedMarketValue(hh, product, { group: "used", status: "ok", valueCents: 41_000, computedAt: new Date(START.getTime() - 3_600_000), n: 30, neff: 20 });

    const html = await (await browser.get(`/products/${product.key}/edit`)).text();

    expect(html).toContain('<dt class="type-ui-label">Used: typical asking price</dt><dd class="type-ui-body ia-num">EUR 410 ');
    // 15 % below EUR 410, rounded down to EUR 10.
    expect(html).toContain('<dt class="type-ui-label">Your limit for used</dt><dd class="type-ui-body ia-num">EUR 340 <span>15 % below');
    expect(html).not.toContain("Save the draft to see the typical asking price");
  });

  it("shows the stored values with their version, and Save changes writes them as the editor", async () => {
    const { browser, id } = await signedInEditor();
    const hh = await harness();
    const product = await seedProduct(hh, { name: "Road bike", searchWords: ["rennrad"], mustWords: [["rennrad"], ["carbon", "alu"]], maxCents: 80_000 });

    const page = await browser.get(`/products/${product.key}/edit`);

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`<form method="post" action="/products/${product.key}/edit"`);
    expect(html).toContain(`<input type="hidden" name="version" value="${String(product.version)}"/>`);
    expect(html).toContain('value="rennrad"');
    expect(html).toContain(">rennrad\ncarbon, alu</textarea>");
    expect(html).toContain('value="800"');
    expect(primaryButtons(html)).toEqual(["Save changes"]);

    const saved = await browser.post(`/products/${product.key}/edit`, {
      ...LENS_FORM,
      _csrf: formToken(html),
      version: String(product.version),
      name: "Road bike",
      searchWords: "rennrad",
      mustWords: "rennrad\ncarbon, alu",
      maxPrice: "750",
      intent: "save",
    });

    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/products/${product.key}`);
    const stored = await hh.db.admin.query("SELECT max_cents, version, status, updated_by::text AS updated_by FROM app.product WHERE id = $1", [product.id]);
    expect(stored.rows[0]).toEqual({ max_cents: 75_000, version: product.version + 1, status: "active", updated_by: id });
  });

  it("refuses a save on an older version with who changed it when, both values, and the person's input kept", async () => {
    const { browser } = await signedInEditor();
    const hh = await harness();
    const simon = await addPerson(hh, "simon@example.test", "admin");
    const product = await seedProduct(hh, { name: "Espresso machine", searchWords: ["siebträger"], mustWords: [["siebträger"]], maxCents: 65_000 });
    const html = await (await browser.get(`/products/${product.key}/edit`)).text();
    hh.clock.set(new Date("2026-10-21T12:05:00.000Z"));
    const other = await saveProductWithPlan(
      hh.db.admin,
      { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, maxCents: 60_000 } },
      { at: hh.clock.now(), actor: `user:${simon}`, userId: simon, env: hh.deps.settingsEnv },
    );
    expect(other.ok).toBe(true);

    const response = await browser.post(`/products/${product.key}/edit`, {
      ...LENS_FORM,
      _csrf: formToken(html),
      version: String(product.version),
      name: "Espresso machine",
      searchWords: "siebträger",
      maxPrice: "700",
      intent: "save",
    });

    expect(response.status).toBe(409);
    const page = await response.text();
    expect(page).toContain("simon@example.test changed this product at 14:05 CEST. Your changes were not saved.");
    expect(page).toContain("Max price (EUR): yours 700, now 600");
    expect(page).toMatch(/name="maxPrice"[^>]*value="700"/);
    expect(page).toContain(`<input type="hidden" name="version" value="${String(product.version + 1)}"/>`);
    const stored = await hh.db.admin.query("SELECT max_cents FROM app.product WHERE id = $1", [product.id]);
    expect(stored.rows[0]).toEqual({ max_cents: 60_000 });
    hh.clock.set(START);
  });

  it("answers cost-preview.ts on the edit form with the cost of the change", async () => {
    const { browser } = await signedInEditor();
    const hh = await harness();
    const product = await seedProduct(hh, { name: "Pram", categoryId: "66698", searchWords: ["kinderwagen"], mustWords: [["kinderwagen"]] });
    const html = await (await browser.get(`/products/${product.key}/edit`)).text();
    const csrf = formToken(html);
    expect(html).toContain(`data-cost-preview="/products/${product.key}/edit/cost"`);

    const reply = (await (
      await browser.post(
        `/products/${product.key}/edit/cost`,
        { ...LENS_FORM, _csrf: csrf, name: "Pram", categoryId: "66698", searchWords: "kinderwagen", speed: "slow" },
        { Accept: "application/json", "X-CSRF-Token": csrf },
      )
    ).json()) as { tone: string; lines: string[] };

    // From normal (240 polls) to slow (80) in its own search.
    expect(reply).toMatchObject({ tone: "info" });
    expect(reply.lines[0]).toMatch(/^This product: -160 calls a day \(joins search s\d+\)\.$/);
    // Out of the plan again, so the budget tests below count without it.
    await saveProductWithPlan(
      hh.db.admin,
      { kind: "update", id: product.id, version: product.version, fields: { ...product.rules, status: "archived" } },
      { at: hh.clock.now(), actor: "system:cli", userId: null, env: hh.deps.settingsEnv },
    );
  });
});

describe("Suggest category", () => {
  it("asks the worker for categories with the search words and keeps the form while it looks", async () => {
    const { browser, id } = await signedInEditor();
    const csrf = formToken(await (await browser.get("/products/new")).text());

    const response = await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, categoryId: "", searchWords: "85mm, Portraitobjektiv", intent: "suggest" });

    expect(response.status).toBe(200);
    const html = await response.text();
    const hh = await harness();
    const requests = await hh.db.admin.query<{ id: string; q: string; status: string; requested_by: string }>(
      "SELECT id, q, status, requested_by::text AS requested_by FROM app.category_request",
    );
    expect(requests.rows).toEqual([{ id: expect.any(String), q: "(85mm,portraitobjektiv)", status: "open", requested_by: id }]);
    expect(html).toContain(`<input type="hidden" name="categoryRequest" value="${requests.rows[0]?.id ?? ""}"/>`);
    expect(html).toContain("Looking for categories. Press Show suggestions in a few seconds.");
    expect(html).toMatch(/<button type="submit" name="intent" value="suggest" class="ia-btn [^"]*ia-btn--secondary[^"]*"><span class="ia-btn__label">Show suggestions/);
    expect(html).toContain('value="85mm, Portraitobjektiv"');
  });

  it("shows the worker's categories as options with their match counts once the request is done", async () => {
    const { browser } = await signedInEditor();
    const hh = await harness();
    const request = (await hh.db.admin.query<{ id: string }>("SELECT id FROM app.category_request")).rows[0];
    const result = { categories: [{ categoryId: "3323", categoryName: "Objektive", matchCount: 112 }, { categoryId: "15200", categoryName: "Filter <b>", matchCount: 3 }] };
    await hh.db.admin.query("UPDATE app.category_request SET status = 'done', result = $2, done_at = $3 WHERE id = $1", [request?.id, JSON.stringify(result), hh.clock.now()]);
    const csrf = formToken(await (await browser.get("/products/new")).text());

    const html = await (
      await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, categoryId: "", categoryRequest: request?.id ?? "", intent: "suggest" })
    ).text();

    expect(html).toMatch(/<input type="radio" name="categoryPick" value="" checked=""/);
    expect(html).toMatch(/<input type="radio" name="categoryPick" value="3323"\/>[\s\S]*?Objektive \(3323\)[\s\S]*?112 matches/);
    expect(html).toContain("Filter &lt;b&gt; (15200)");
    expect(html).not.toContain("Filter <b>");
    expect((await hh.db.admin.query("SELECT count(*)::int AS n FROM app.category_request")).rows).toEqual([{ n: 1 }]);
  });

  it("saves a picked suggestion as the category with the name eBay gave it", async () => {
    const { browser } = await signedInEditor();
    const hh = await harness();
    const request = (await hh.db.admin.query<{ id: string }>("SELECT id FROM app.category_request")).rows[0];
    const csrf = formToken(await (await browser.get("/products/new")).text());

    const response = await browser.post("/products/new", {
      ...LENS_FORM,
      _csrf: csrf,
      name: "Picked lens",
      categoryId: "",
      categoryRequest: request?.id ?? "",
      categoryPick: "3323",
      intent: "save",
    });

    expect(response.status).toBe(303);
    const stored = await hh.db.admin.query("SELECT category_id, category_name FROM app.product WHERE name = 'Picked lens'");
    expect(stored.rows).toEqual([{ category_id: "3323", category_name: "Objektive" }]);
  });

  it("offers the categories other products use as quick picks next to the field (spec 8.4 item 5)", async () => {
    const { browser } = await signedInEditor();

    const html = await (await browser.get("/products/new")).text();

    expect(html).toMatch(/<input type="radio" name="categoryInUse" value="" checked=""/);
    expect(html).toMatch(/<input type="radio" name="categoryInUse" value="3323"\/>[\s\S]*?Objektive \(3323\)/);
  });

  it("saves a quick pick as the category with the name stored for it, whatever ID was typed", async () => {
    const { browser } = await signedInEditor();
    const hh = await harness();
    const csrf = formToken(await (await browser.get("/products/new")).text());

    const response = await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, name: "Quick pick lens", categoryId: "", categoryInUse: "3323", intent: "save" });

    expect(response.status).toBe(303);
    const stored = await hh.db.admin.query("SELECT category_id, category_name FROM app.product WHERE name = 'Quick pick lens'");
    expect(stored.rows).toEqual([{ category_id: "3323", category_name: "Objektive" }]);
  });
});

describe("Test a title", () => {
  it("names the outcome and the rule that fired for the typed title, with the form's unsaved rules", async () => {
    const { browser } = await signedInEditor();
    const csrf = formToken(await (await browser.get("/products/new")).text());
    const hh = await harness();
    const before = await hh.db.admin.query("SELECT count(*)::int AS n FROM app.product");

    // "kratzer" is typed into the form but not saved anywhere.
    const response = await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, excludeWords: "kratzer", testTitle: "Canon EF 85mm 1.8 mit Kratzer", intent: "test" });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Filtered out: Has a word you excluded (Must not contain).");
    expect(html).toMatch(/name="testTitle"[^>]*value="Canon EF 85mm 1.8 mit Kratzer"/);
    expect((await hh.db.admin.query("SELECT count(*)::int AS n FROM app.product")).rows).toEqual(before.rows);
  });

  it("says when a title passes every rule, and a title in a hostile form stays text", async () => {
    const { browser } = await signedInEditor();
    const csrf = formToken(await (await browser.get("/products/new")).text());
    const title = 'Canon 85mm "><script>alert(1)</script>';

    const html = await (await browser.post("/products/new", { ...LENS_FORM, _csrf: csrf, testTitle: title, intent: "test" })).text();

    expect(html).toContain("Matches your rules.");
    expect(html).toContain('value="Canon 85mm &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).not.toContain("<script>alert(1)");
  });
});

// These run last: they fill the plan close to its ceiling of 2,500 calls a day.
describe("the plan over budget", () => {
  const fillPlan = async () => {
    const hh = await harness();
    for (const [at, word] of ["kamera", "fahrrad", "kaffee"].entries()) {
      await seedProduct(hh, { name: `Full ${word}`, categoryId: `90${String(at)}`, speed: "fast", searchWords: [word], mustWords: [[word]] });
    }
  };

  it("shows the cost in danger with the cheapest change that fits, with and without script", async () => {
    await fillPlan();
    const { browser } = await signedInEditor();
    const csrf = formToken(await (await browser.get("/products/new")).text());
    const form = { ...LENS_FORM, _csrf: csrf, categoryId: "179", speed: "fast" };

    const plain = costBox(await (await browser.post("/products/new", { ...form, intent: "cost" })).text());
    const reply = (await (await browser.post("/products/new/cost", form, { Accept: "application/json", "X-CSRF-Token": csrf })).json()) as {
      tone: string;
      lines: string[];
    };

    expect(reply.tone).toBe("danger");
    expect(reply.lines[0]).toBe("When active: +541 calls a day (new search for category 179 at fast speed).");
    expect(reply.lines[1]).toMatch(/^Total once active [\d,]+ of 2,500: [\d,]+ over the plan\.$/);
    expect(reply.lines[2]).toBe("Fits at slow speed (+93) or at normal speed (+253).");
    expect(plain).toContain("ia-callout--danger");
    for (const line of reply.lines) expect(plain).toContain(line);
  });

  it("refuses a save that takes the plan over 2,500 and shows why in the cost box", async () => {
    const { browser } = await signedInEditor();
    const hh = await harness();
    const found = await hh.db.admin.query<{ key: string; version: number }>("SELECT key, version FROM app.product WHERE name = 'Espresso machine'");
    const espresso = found.rows[0];
    if (espresso === undefined) throw new Error("the espresso machine of the conflict test is missing");
    const csrf = formToken(await (await browser.get(`/products/${espresso.key}/edit`)).text());

    const response = await browser.post(`/products/${espresso.key}/edit`, {
      ...LENS_FORM,
      _csrf: csrf,
      version: String(espresso.version),
      name: "Espresso machine",
      searchWords: "siebträger",
      maxPrice: "600",
      categoryId: "179",
      speed: "fast",
      intent: "save",
    });

    expect(response.status).toBe(422);
    const box = costBox(await response.text());
    expect(box).toContain("ia-callout--danger");
    // The planner gives the moved product's group the id of the search it leaves (largest overlap).
    expect(box).toMatch(/This product: \+538 calls a day \(joins search s\d+\)\./);
    const stored = await hh.db.admin.query("SELECT category_id, speed FROM app.product WHERE key = $1", [espresso.key]);
    expect(stored.rows[0]).toEqual({ category_id: "3323", speed: "normal" });
  });
});
