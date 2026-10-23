import { afterAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, signIn, type Browser, type Harness } from "../../testing/harness.js";
import { seedProduct } from "../products/testing/products.js";

// Spec 8.3 /settings and 2.5: the Claude, Alerts and Matching sections. Admins change them within
// the .env ceilings; editors see the values read-only.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const primaryButtons = (html: string): number => html.match(/ia-btn--primary/g)?.length ?? 0;

// One signed-in browser per address for the whole file: the sign-in caps allow only a few codes
// an hour for an address.
const browsers = new Map<string, Browser>();

async function signedIn(email: string, role: "admin" | "editor"): Promise<{ hh: Harness; browser: Browser }> {
  const hh = await harness();
  const known = browsers.get(email);
  if (known !== undefined) return { hh, browser: known };
  await addPerson(hh, email, role);
  const browser = hh.browser();
  await signIn(hh, browser, email);
  browsers.set(email, browser);
  return { hh, browser };
}

describe("GET /settings", () => {
  it("offers only the model and effort pairs that passed the eval, each with its worst case and the checks the spend cap covers", async () => {
    const { browser } = await signedIn("admin@example.test", "admin");

    const response = await browser.get("/settings");

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Settings - Just-Buy-It</title>");
    expect(html).toContain('value="claude-sonnet-5-5:medium" checked=""');
    expect(html).toContain('value="claude-haiku-5-5:medium"');
    expect(html).not.toContain("claude-sonnet-5-5:low");
    expect(html).not.toContain("claude-opus-5-5");
    expect(html).toContain("Sonnet 5.5, medium effort");
    expect(html).toContain("Eval passed 20 Oct 2026");
    expect(html).toContain("Worst case $0.067 a check. $2.00 covers 29 checks; your call cap is 40.");
    expect(html).toContain("Worst case $0.004 a check. $2.00 covers 597 checks; your call cap is 40.");
    expect(primaryButtons(html)).toBe(1);
    expect(html).toContain("Save settings");
  });

  it("shows the call and spend caps with the .env ceiling in the hint", async () => {
    const { browser } = await signedIn("admin@example.test", "admin");

    const html = await (await browser.get("/settings")).text();

    expect(html).toMatch(/<input[^>]*name="claude.daily_call_limit"[^>]*value="40"/);
    expect(html).toContain("At most 40, the server ceiling (CLAUDE_DAILY_CALL_LIMIT). 0 turns the Claude check off.");
    expect(html).toMatch(/<input[^>]*name="claude.daily_spend_limit_usd"[^>]*value="2.00"/);
    expect(html).toContain("At most $2.00, the server ceiling (CLAUDE_DAILY_SPEND_LIMIT_USD).");
  });

  it("warns in a Banner when a stored cap is above the .env ceiling, and fills the field with the cap that applies", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query(
      `INSERT INTO app.setting (key, value) VALUES ('claude.daily_spend_limit_usd', '"8.00"')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    const html = await (await browser.get("/settings")).text();

    expect(html).toMatch(/class="ia-banner ia-banner--warning"[\s\S]*Stored Claude spend cap \$8.00 is above the server ceiling \$2.00; \$2.00 applies./);
    expect(html).toMatch(/<input[^>]*name="claude.daily_spend_limit_usd"[^>]*value="2.00"/);
    await hh.db.admin.query("DELETE FROM app.setting WHERE key = 'claude.daily_spend_limit_usd'");
  });

  it("shows an editor the values read-only, without a form or a Save button", async () => {
    const { browser } = await signedIn("editor@example.test", "editor");

    const html = await (await browser.get("/settings")).text();

    expect(html).not.toContain('action="/settings"');
    expect(html).not.toContain("Save settings");
    expect(primaryButtons(html)).toBe(0);
    expect(html).toContain("Only admins can change settings.");
    expect(html).toMatch(/Model and effort<\/dt><dd[^>]*>Sonnet 5.5, medium effort/);
    expect(html).toMatch(/Claude checks a day<\/dt><dd[^>]*>40/);
    expect(html).toMatch(/Claude spend a day<\/dt><dd[^>]*>\$2.00/);
  });
});

describe("GET /settings/alerts", () => {
  it("shows the alert rates and the default buyer profile, with the section tabs and one primary Save settings", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");

    const html = await (await browser.get("/settings/alerts")).text();

    expect(html).toMatch(/<a href="\/settings\/alerts" aria-current="page"/);
    expect(html).toContain('<a href="/settings"');
    expect(html).toContain('<a href="/settings/matching"');
    expect(html).toContain('action="/settings/alerts"');
    expect(html).toMatch(/<input[^>]*name="alerts.per_hour"[^>]*value="10"/);
    expect(html).toMatch(/<input[^>]*name="alerts.per_day"[^>]*value="60"/);
    expect(html).toMatch(/<input type="radio" name="alerts.default_buyer_profile" value="company" checked=""/);
    expect(primaryButtons(html)).toBe(1);
  });

  it("shows an editor the alert settings read-only", async () => {
    const { browser } = await signedIn("editor@example.test", "editor");

    const html = await (await browser.get("/settings/alerts")).text();

    expect(html).not.toContain('action="/settings/alerts"');
    expect(html).toMatch(/Alerts an hour<\/dt><dd[^>]*>10/);
    expect(html).toMatch(/Alerts a day<\/dt><dd[^>]*>60/);
    expect(html).toMatch(/Default buyer profile for new products<\/dt><dd[^>]*>Company/);
  });
});

describe("GET /settings/matching", () => {
  it("shows the low-feedback threshold as a field and the default junk rules read-only", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");

    const html = await (await browser.get("/settings/matching")).text();

    expect(html).toContain('action="/settings/matching"');
    expect(html).toMatch(/<input[^>]*name="matcher.low_feedback_below"[^>]*value="10"/);
    expect(html).toContain("Default junk rules");
    expect(html).toMatch(/<th scope="row"[^>]*>defect<\/th>/);
    expect(html).toContain("defekt*, kaputt*, bastler*");
    expect(html).not.toMatch(/<input[^>]*name="[^"]*junk/);
    expect(primaryButtons(html)).toBe(1);
  });

  it("shows an editor the threshold and the junk rules read-only", async () => {
    const { browser } = await signedIn("editor@example.test", "editor");

    const html = await (await browser.get("/settings/matching")).text();

    expect(html).not.toContain('action="/settings/matching"');
    expect(html).toMatch(/Low seller feedback below<\/dt><dd[^>]*>10/);
    expect(html).toMatch(/<th scope="row"[^>]*>defect<\/th>/);
  });
});

describe("POST /settings", () => {
  it("refuses a call cap above the .env ceiling, says why at the field and stores nothing", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");
    const csrf = formToken(await (await browser.get("/settings")).text());

    const response = await browser.post("/settings", {
      _csrf: csrf,
      choice: "claude-sonnet-5-5:medium",
      "claude.daily_call_limit": "41",
      "claude.daily_spend_limit_usd": "2.00",
    });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("The server ceiling is 40 calls a day (CLAUDE_DAILY_CALL_LIMIT).");
    expect(html).toMatch(/<input[^>]*aria-invalid="true"[^>]*name="claude.daily_call_limit"[^>]*value="41"/);
    const stored = await hh.db.admin.query("SELECT key FROM app.setting");
    expect(stored.rows).toEqual([]);
  });

  it("stores only the settings that changed, audited as the person, and goes back to the page", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");
    const csrf = formToken(await (await browser.get("/settings")).text());

    const response = await browser.post("/settings", {
      _csrf: csrf,
      choice: "claude-haiku-5-5:medium",
      "claude.daily_call_limit": "40",
      "claude.daily_spend_limit_usd": "1.5",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
    const stored = await hh.db.admin.query("SELECT key, value FROM app.setting ORDER BY key");
    expect(stored.rows).toEqual([
      { key: "claude.daily_spend_limit_usd", value: "1.50" },
      { key: "claude.model", value: "claude-haiku-5-5" },
    ]);
    const admin = await hh.db.admin.query<{ id: string }>("SELECT id FROM auth.app_user WHERE email = 'admin@example.test'");
    const audit = await hh.db.admin.query("SELECT actor, detail->>'key' AS key FROM app.audit_event WHERE action = 'setting.changed' ORDER BY key");
    expect(audit.rows).toEqual([
      { actor: `user:${String(admin.rows[0]?.id)}`, key: "claude.daily_spend_limit_usd" },
      { actor: `user:${String(admin.rows[0]?.id)}`, key: "claude.model" },
    ]);
    expect(await (await browser.get("/settings")).text()).toContain('value="claude-haiku-5-5:medium" checked=""');
  });

  it("stores the cap that applies when a stored cap above the ceiling is saved unchanged, which ends the warning", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");
    await hh.db.admin.query(`INSERT INTO app.setting (key, value) VALUES ('claude.daily_spend_limit_usd', '"8.00"')`);
    const csrf = formToken(await (await browser.get("/settings")).text());

    const response = await browser.post("/settings", {
      _csrf: csrf,
      choice: "claude-sonnet-5-5:medium",
      "claude.daily_call_limit": "40",
      "claude.daily_spend_limit_usd": "2.00",
    });

    expect(response.status).toBe(303);
    const stored = await hh.db.admin.query("SELECT key, value FROM app.setting");
    expect(stored.rows).toEqual([{ key: "claude.daily_spend_limit_usd", value: "2.00" }]);
    expect(await (await browser.get("/settings")).text()).not.toContain("ia-banner--warning");
  });

  it("refuses a model and effort pair that did not pass the eval, even when posted by hand", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");
    const csrf = formToken(await (await browser.get("/settings")).text());

    const response = await browser.post("/settings", {
      _csrf: csrf,
      choice: "claude-opus-5-5:medium",
      "claude.daily_call_limit": "40",
      "claude.daily_spend_limit_usd": "2.00",
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("claude-opus-5-5 at effort medium has not passed the screening eval for the current prompt.");
    expect((await hh.db.admin.query("SELECT key FROM app.setting")).rows).toEqual([]);
  });

  it("refuses a call cap that would raise the daily call plan over 2,500 and names the numbers", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");
    await hh.db.admin.query(`INSERT INTO app.setting (key, value) VALUES ('claude.daily_call_limit', '10')`);
    // 4 fast searches and 1 slow with overflow: 2,242; sweeps of 3 price-drop checks: 72; market
    // 75; getItem 36 at 10 Claude calls, 126 at 40. So 2,425 now, 2,515 after the save.
    const products = [
      { categoryId: "101", speed: "fast", priceDropCheck: true },
      { categoryId: "102", speed: "fast", priceDropCheck: true },
      { categoryId: "103", speed: "fast", priceDropCheck: true },
      { categoryId: "104", speed: "fast" },
      { categoryId: "105", speed: "slow" },
    ];
    for (const fields of products) await seedProduct(hh, fields);
    const csrf = formToken(await (await browser.get("/settings")).text());

    const response = await browser.post("/settings", {
      _csrf: csrf,
      choice: "claude-sonnet-5-5:medium",
      "claude.daily_call_limit": "40",
      "claude.daily_spend_limit_usd": "2.00",
    });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("The daily call plan would be 2,515 of 2,500 eBay calls. Nothing was saved.");
    const stored = await hh.db.admin.query("SELECT value FROM app.setting WHERE key = 'claude.daily_call_limit'");
    expect(stored.rows).toEqual([{ value: 10 }]);
    await hh.db.admin.query("UPDATE app.product SET status = 'archived'");
    await hh.db.admin.query("DELETE FROM app.search_product");
    await hh.db.admin.query("UPDATE app.search SET retired_at = now(), enabled = false");
  });

  it("saves the alert rates on their own page, and refuses a rate out of bounds without storing the rest", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");
    const csrf = formToken(await (await browser.get("/settings/alerts")).text());
    const post = (perHour: string) =>
      browser.post("/settings/alerts", { _csrf: csrf, "alerts.per_hour": perHour, "alerts.per_day": "50", "alerts.default_buyer_profile": "private" });

    const refused = await post("21");

    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("Enter 1 to 20.");
    expect((await hh.db.admin.query("SELECT key FROM app.setting")).rows).toEqual([]);

    const saved = await post("5");

    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/settings/alerts");
    const stored = await hh.db.admin.query("SELECT key, value FROM app.setting ORDER BY key");
    expect(stored.rows).toEqual([
      { key: "alerts.default_buyer_profile", value: "private" },
      { key: "alerts.per_day", value: 50 },
      { key: "alerts.per_hour", value: 5 },
    ]);
  });

  it("says so when no pair has passed the eval yet, and still saves the caps", async () => {
    const { hh, browser } = await signedIn("admin@example.test", "admin");
    await hh.db.admin.query("DELETE FROM app.setting");
    const passed = hh.deps.screeningOptions;
    hh.deps.screeningOptions = [];
    try {
      const html = await (await browser.get("/settings")).text();
      expect(html).toContain("No model has passed the screening eval for the current prompt yet. The Claude check uses Sonnet 5.5, medium effort.");
      expect(html).not.toContain('name="choice"');

      const response = await browser.post("/settings", { _csrf: formToken(html), "claude.daily_call_limit": "20", "claude.daily_spend_limit_usd": "2.00" });

      expect(response.status).toBe(303);
      expect((await hh.db.admin.query("SELECT key, value FROM app.setting")).rows).toEqual([{ key: "claude.daily_call_limit", value: 20 }]);
    } finally {
      hh.deps.screeningOptions = passed;
    }
  });

  it("gives an editor 403 and changes nothing", async () => {
    const { hh, browser } = await signedIn("editor@example.test", "editor");
    await hh.db.admin.query("DELETE FROM app.setting");
    const csrf = formToken(await (await browser.get("/settings")).text());

    const response = await browser.post("/settings", {
      _csrf: csrf,
      choice: "claude-haiku-5-5:medium",
      "claude.daily_call_limit": "10",
      "claude.daily_spend_limit_usd": "1.00",
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Only admins can change this. Ask an admin.");
    expect((await hh.db.admin.query("SELECT key FROM app.setting")).rows).toEqual([]);
  });
});
