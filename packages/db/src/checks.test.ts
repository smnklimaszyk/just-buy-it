import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Spec 2.1 to 2.9: every check of the v2 tables refuses a bad row, and the widened checks of 2.9
// accept what v2 writes.

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

type Row = Record<string, unknown>;

async function insert(table: string, row: Row): Promise<Row> {
  const columns = Object.keys(row);
  const result = await database.pool.query<Row>(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    Object.values(row),
  );
  const [inserted] = result.rows;
  if (inserted === undefined) throw new Error(`INSERT INTO ${table} returned no row`);
  return inserted;
}

const PRODUCT: Row = {
  name: "Test product",
  description: "A product used by the check tests",
  category_id: "27386",
  condition_ids: ["3000", "1500"],
  search_words: ["word"],
  must_words: JSON.stringify([["word"]]),
  price_mode: "fixed",
  max_cents: 50_000,
  sweep_minute: 7,
  buyer_profile: "company",
};

let productCount = 0;

async function product(overrides: Row = {}): Promise<Row> {
  productCount += 1;
  return insert("app.product", { ...PRODUCT, key: `p_k${String(productCount).padStart(9, "0")}`, ...overrides });
}

describe("app.product", () => {
  it("takes a minimal draft with the defaults of spec 2.1", async () => {
    const row = await product();

    expect(row).toMatchObject({
      status: "draft",
      exclude_words: [],
      warn_words: [],
      use_default_junk: true,
      junk_exceptions: [],
      accessory_check: true,
      per_gb: false,
      unit_min_total: null,
      unit_max_total: null,
      below_market_pct: null,
      floor_cents: null,
      read_ceiling_cents: null,
      category_name: null,
      speed: "normal",
      price_drop_check: false,
      candidate_cap_per_day: 10,
      claude_required: false,
      alert_recipient_ids: [],
      version: 1,
      match_version: 1,
      watch_from: null,
      created_by: null,
      updated_by: null,
    });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
  const uuids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`);

  it.each([
    ["key", { key: "Gpu_3090" }, "product_key_format"],
    ["key", { key: "p" }, "product_key_format"],
    ["name", { name: "" }, "product_name_length"],
    ["name", { name: "x".repeat(61) }, "product_name_length"],
    ["name", { name: "<b>deal</b>" }, "product_no_markup"],
    ["description", { description: "" }, "product_description_length"],
    ["description", { description: "x".repeat(301) }, "product_description_length"],
    ["description", { description: "a < b" }, "product_no_markup"],
    ["status", { status: "deleted" }, "product_status_known"],
    ["category_id", { category_id: "27386a" }, "product_category_id_format"],
    ["condition_ids", { condition_ids: [] }, "product_condition_ids_format"],
    ["condition_ids", { condition_ids: ["300"] }, "product_condition_ids_format"],
    ["condition_ids", { condition_ids: words(16).map((_, i) => String(1000 + i)) }, "product_condition_ids_format"],
    ["condition_ids", { condition_ids: ["3000", null] }, "product_condition_ids_format"],
    ["condition_ids", { condition_ids: ["3000", "7000"] }, "product_condition_ids_no_parts"],
    ["search_words", { search_words: [] }, "product_list_sizes"],
    ["search_words", { search_words: words(9) }, "product_list_sizes"],
    ["exclude_words", { exclude_words: words(61) }, "product_list_sizes"],
    ["warn_words", { warn_words: words(31) }, "product_list_sizes"],
    ["junk_exceptions", { junk_exceptions: words(21) }, "product_list_sizes"],
    ["alert_recipient_ids", { alert_recipient_ids: uuids(21) }, "product_list_sizes"],
    ["must_words", { must_words: JSON.stringify({ group: ["word"] }) }, "product_must_words_shape"],
    ["must_words", { must_words: JSON.stringify([]) }, "product_must_words_shape"],
    ["must_words", { must_words: JSON.stringify(Array.from({ length: 7 }, () => ["word"])) }, "product_must_words_shape"],
    ["per_gb", { per_gb: true }, "product_per_gb_units"],
    ["per_gb", { per_gb: true, unit_min_total: 0, unit_max_total: 64 }, "product_per_gb_units"],
    ["per_gb", { per_gb: true, unit_min_total: 64, unit_max_total: 32 }, "product_per_gb_units"],
    ["price_mode", { price_mode: "market" }, "product_price_mode_known"],
    ["below_market_pct", { price_mode: "below_market" }, "product_below_market_pct"],
    ["below_market_pct", { below_market_pct: 15 }, "product_below_market_pct"],
    ["below_market_pct", { price_mode: "below_market", below_market_pct: 0 }, "product_below_market_pct"],
    ["below_market_pct", { price_mode: "below_market", below_market_pct: 91 }, "product_below_market_pct"],
    ["max_cents", { max_cents: 0 }, "product_max_positive"],
    ["floor_cents", { floor_cents: 50_001 }, "product_floor_range"],
    ["floor_cents", { floor_cents: 0 }, "product_floor_range"],
    ["read_ceiling_cents", { read_ceiling_cents: 0 }, "product_read_ceiling_positive"],
    ["speed", { speed: "turbo" }, "product_speed_known"],
    ["sweep_minute", { sweep_minute: 60 }, "product_sweep_minute_range"],
    ["candidate_cap_per_day", { candidate_cap_per_day: 201 }, "product_candidate_cap_range"],
    ["candidate_cap_per_day", { candidate_cap_per_day: -1 }, "product_candidate_cap_range"],
    ["buyer_profile", { buyer_profile: "reseller" }, "product_buyer_profile_known"],
    ["version", { version: 0 }, "product_versions_positive"],
    ["match_version", { match_version: 0 }, "product_versions_positive"],
  ])("refuses a bad %s (%j)", async (_column, overrides, constraint) => {
    await expect(product(overrides)).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("refuses a second product with the same key", async () => {
    await product({ key: "gpu_3090" });

    await expect(product({ key: "gpu_3090" })).rejects.toMatchObject({ code: "23505", constraint: "product_key_unique" });
  });
});

describe("app.product_source and app.product_revision", () => {
  it("keeps one row per product and source, and Kleinanzeigen fields only on Kleinanzeigen rows", async () => {
    const { id } = await product();
    const source = (row: Row) => insert("app.product_source", { product_id: id, enabled: true, ...row });
    await source({ source: "ebay" });
    await source({ source: "kleinanzeigen", enabled: false, ka_saved_search_id: "123", ka_price_limit_cents: 40_000 });

    await expect(source({ source: "ebay" })).rejects.toMatchObject({ code: "23505" });
    await expect(source({ source: "amazon" })).rejects.toMatchObject({ code: "23514", constraint: "product_source_source_known" });
    await database.pool.query("DELETE FROM app.product_source");
    await expect(source({ source: "ebay", ka_saved_search_id: "1" })).rejects.toMatchObject({
      code: "23514",
      constraint: "product_source_ka_fields",
    });
    await expect(source({ source: "kleinanzeigen", ka_price_limit_cents: 0 })).rejects.toMatchObject({
      code: "23514",
      constraint: "product_source_ka_fields",
    });
    await expect(
      insert("app.product_source", { product_id: "00000000-0000-7000-8000-000000000001", source: "ebay", enabled: true }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps one revision per product and version, with an actor in audit format", async () => {
    const { id } = await product();
    const revision = (row: Row) => insert("app.product_revision", { product_id: id, rules: JSON.stringify({}), ...row });
    const saved = await revision({ version: 1, actor: "system:import" });

    expect(saved.created_at).toBeInstanceOf(Date);
    await expect(revision({ version: 1, actor: "system:cli" })).rejects.toMatchObject({ code: "23505" });
    await expect(revision({ version: 2, actor: "Simon" })).rejects.toMatchObject({
      code: "23514",
      constraint: "product_revision_actor_format",
    });
    await expect(revision({ version: 0, actor: "system:cli" })).rejects.toMatchObject({
      code: "23514",
      constraint: "product_revision_version_positive",
    });
  });
});

describe("app.search, app.search_product, app.setting", () => {
  const SEARCH: Row = {
    category_id: "27386",
    condition_ids: ["3000"],
    q: "(3090,rtx3090)",
    floor_eur: 260,
    ceiling_eur: 1100,
    day_interval_s: 300,
    night_interval_s: 600,
    enabled: true,
    members_hash: "h",
  };

  it("takes search ids from the sequence, one after the other", async () => {
    const next = async () =>
      (await database.pool.query<{ id: string }>("SELECT 's' || nextval('app.search_id_seq') AS id")).rows[0]?.id ?? "";
    const first = await next();
    const second = await next();

    expect(first).toMatch(/^s[1-9][0-9]*$/);
    expect(Number(second.slice(1))).toBe(Number(first.slice(1)) + 1);
    const row = await insert("app.search", { ...SEARCH, id: first });
    expect(row).toMatchObject({ retired_at: null });
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it.each([
    [{ id: "gpu" }, "search_id_format"],
    [{ id: "s0" }, "search_id_format"],
    [{ category_id: "x" }, "search_category_id_format"],
    [{ condition_ids: [] }, "search_condition_ids_format"],
    [{ day_interval_s: 59 }, "search_intervals"],
    [{ night_interval_s: 0 }, "search_intervals"],
    [{ floor_eur: -1 }, "search_price_range"],
    [{ floor_eur: 200, ceiling_eur: 100 }, "search_price_range"],
  ])("refuses a bad search %j", async (overrides, constraint) => {
    await expect(insert("app.search", { ...SEARCH, id: "s900", ...overrides })).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
  });

  it("links a search and a product once, and only existing ones", async () => {
    const { id } = await product();
    await insert("app.search", { ...SEARCH, id: "s700" });
    await insert("app.search_product", { search_id: "s700", product_id: id });

    await expect(insert("app.search_product", { search_id: "s700", product_id: id })).rejects.toMatchObject({ code: "23505" });
    await expect(insert("app.search_product", { search_id: "s701", product_id: id })).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps settings by dotted key with a version", async () => {
    const row = await insert("app.setting", { key: "claude.model", value: JSON.stringify("claude-sonnet-5-5") });

    expect(row).toMatchObject({ value: "claude-sonnet-5-5", version: 1, updated_by: null });
    expect(row.updated_at).toBeInstanceOf(Date);
    await expect(insert("app.setting", { key: "claude.model", value: "1" })).rejects.toMatchObject({ code: "23505" });
    await expect(insert("app.setting", { key: "Claude", value: "1" })).rejects.toMatchObject({
      code: "23514",
      constraint: "setting_key_format",
    });
    await expect(insert("app.setting", { key: "alerts.per_hour", value: "10", version: 0 })).rejects.toMatchObject({
      code: "23514",
      constraint: "setting_version_positive",
    });
  });
});

const KEY = "a".repeat(64);

describe("market tables (spec 2.4)", () => {
  const listingRow = (productId: unknown, overrides: Row = {}): Row => ({
    product_id: productId,
    match_version: 1,
    source: "ebay",
    item_key: KEY,
    condition_group: "used",
    landed_cents: 60_000,
    origin_at: new Date("2026-10-01T10:00:00Z"),
    first_seen_at: new Date("2026-10-21T10:00:00Z"),
    last_seen_at: new Date("2026-10-21T10:00:00Z"),
    best_offer: false,
    ...overrides,
  });

  it("keeps one market listing per product, source and item key", async () => {
    const { id } = await product();
    const row = await insert("app.market_listing", listingRow(id));

    expect(row).toMatchObject({ unit_total: null, excluded_reason: null });
    await expect(insert("app.market_listing", listingRow(id, { landed_cents: 1 }))).rejects.toMatchObject({ code: "23505" });
    await insert("app.market_listing", listingRow(id, { source: "kleinanzeigen" }));
  });

  it.each([
    [{ item_key: "x" }, "market_listing_item_key_format"],
    [{ source: "amazon" }, "market_listing_source_known"],
    [{ condition_group: "for_parts" }, "market_listing_condition_group_known"],
    [{ condition_group: null }, "market_listing_condition_group_known"],
    [{ excluded_reason: "Not A Code" }, "market_listing_excluded_reason_format"],
    [{ landed_cents: -1 }, "market_listing_counts"],
    [{ match_version: 0 }, "market_listing_counts"],
  ])("refuses a bad market listing %j, and takes an excluded one without a group", async (overrides, constraint) => {
    const { id } = await product();
    await insert("app.market_listing", listingRow(id, { item_key: "b".repeat(64), condition_group: null, excluded_reason: "unknown_condition" }));

    await expect(insert("app.market_listing", listingRow(id, overrides))).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("keeps market values with a known status and group, prices nullable for the 30-day purge", async () => {
    const { id } = await product();
    const value: Row = {
      product_id: id,
      condition_group: "used",
      match_version: 1,
      computed_at: new Date("2026-10-21T03:00:00Z"),
      method_version: "mv-1",
      status: "ok",
      capped: false,
      n: 12,
      neff: "9.5",
      m_cents: 61_000,
      value_cents: 61_000,
      counts: JSON.stringify({ seen: 40 }),
    };
    const row = await insert("app.market_value", value);

    expect(row).toMatchObject({ p25_cents: null, half_width: null, best_offer_share: null, neff: "9.5" });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    for (const [overrides, constraint] of [
      [{ status: "stale" }, "market_value_status_known"],
      [{ condition_group: "any" }, "market_value_condition_group_known"],
      [{ n: -1 }, "market_value_counts"],
    ] as const) {
      await expect(insert("app.market_value", { ...value, ...overrides })).rejects.toMatchObject({ code: "23514", constraint });
    }
  });

  const marketRequest = (productId: unknown, row: Row = {}) =>
    insert("app.market_request", {
      product_id: productId,
      reason: "created",
      requested_at: new Date("2026-10-21T10:00:00Z"),
      ...row,
    });

  it("keeps one open market request per product", async () => {
    const { id } = await product();
    const first = await marketRequest(id);

    expect(first).toMatchObject({ status: "open", requested_by: null, done_at: null });
    await expect(marketRequest(id, { reason: "check_now", status: "queued" })).rejects.toMatchObject({
      code: "23505",
      constraint: "market_request_one_open",
    });
    await database.pool.query("UPDATE app.market_request SET status = 'done', done_at = requested_at");
    await marketRequest(id, { reason: "check_now", status: "running" });
  });

  it.each([
    ["market_request_reason_known", { reason: "bored", status: "done", done_at: new Date("2026-10-21T10:01:00Z") }],
    ["market_request_status_known", { status: "lost" }],
    ["market_request_done_at", { status: "refused" }],
    ["market_request_done_at", { status: "open", done_at: new Date("2026-10-21T10:01:00Z") }],
  ])("refuses a market request against %s (%j)", async (constraint, row) => {
    const { id } = await product();

    await expect(marketRequest(id, row)).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("keeps a category request from the form until the worker answers it", async () => {
    const row = await insert("app.category_request", { q: "kaffeevollautomat" });

    expect(row).toMatchObject({ status: "open", requested_by: null, result: null, done_at: null });
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it.each([
    ["category_request_q_length", { q: "" }],
    ["category_request_q_length", { q: "x".repeat(201) }],
    ["category_request_status_known", { q: "x", status: "lost" }],
    ["category_request_done_at", { q: "x", status: "done" }],
  ])("refuses a category request against %s (%j)", async (constraint, row) => {
    await expect(insert("app.category_request", row)).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("records a market run as running until it finishes", async () => {
    const { id } = await product();
    const startedAt = new Date("2026-10-21T03:00:00Z");
    const row = await insert("app.market_run", { product_id: id, started_at: startedAt });

    expect(row).toMatchObject({ status: "running", finished_at: null, calls: 0, pages: 0, total: null, error_kind: null });
    await insert("app.market_run", { product_id: id, started_at: startedAt, finished_at: startedAt, status: "discarded" });
  });

  it.each([
    ["market_run_status_known", { status: "lost", finished_at: new Date("2026-10-21T03:01:00Z") }],
    ["market_run_finished_unless_running", { status: "ok" }],
    ["market_run_finished_unless_running", { finished_at: new Date("2026-10-21T03:01:00Z") }],
    ["market_run_error_kind_format", { error_kind: "HTTP 500" }],
    ["market_run_counts", { calls: -1 }],
  ])("refuses a market run against %s (%j)", async (constraint, row) => {
    const { id } = await product();

    await expect(
      insert("app.market_run", { product_id: id, started_at: new Date("2026-10-21T03:00:00Z"), ...row }),
    ).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("keeps the newest snapshot's titles per product and item key in ebay_live", async () => {
    const { id } = await product();
    const preview: Row = {
      product_id: id,
      item_key: KEY,
      legacy_item_id: "123456789012",
      title: "RTX 3090 Founders Edition",
      landed_cents: 61_000,
      condition_group: "used",
      outcome: "counted",
      seen_at: new Date("2026-10-21T03:00:00Z"),
    };
    await insert("ebay_live.market_preview", preview);

    await expect(insert("ebay_live.market_preview", preview)).rejects.toMatchObject({ code: "23505" });
    await expect(
      insert("ebay_live.market_preview", { ...preview, item_key: "c".repeat(64), legacy_item_id: "v1|1|0" }),
    ).rejects.toMatchObject({ code: "23514", constraint: "market_preview_legacy_item_id_format" });
    await expect(
      insert("ebay_live.market_preview", { ...preview, item_key: "c".repeat(64), outcome: "Counted!" }),
    ).rejects.toMatchObject({ code: "23514", constraint: "market_preview_outcome_format" });
  });

  it("counts extra snapshots once per Berlin day", async () => {
    await insert("app.market_daily", { day_berlin: "2026-10-21" });

    const rows = await database.pool.query("SELECT day_berlin::text AS day, extra_snapshots FROM app.market_daily");
    expect(rows.rows).toEqual([{ day: "2026-10-21", extra_snapshots: 0 }]);
    await expect(insert("app.market_daily", { day_berlin: "2026-10-21" })).rejects.toMatchObject({ code: "23505" });
    await expect(insert("app.market_daily", { day_berlin: "2026-10-22", extra_snapshots: -1 })).rejects.toMatchObject({
      code: "23514",
      constraint: "market_daily_extra_snapshots",
    });
  });
});

let userCount = 0;

async function appUser(overrides: Row = {}): Promise<Row> {
  userCount += 1;
  return insert("auth.app_user", { email: `person${userCount}@example.org`, role: "editor", ...overrides });
}

describe("auth tables (spec 2.6)", () => {
  it("keeps one person per address, whatever its case", async () => {
    const first = await appUser({ email: "Info@Intra-AI.de", role: "admin" });

    expect(first).toMatchObject({ status: "active", created_by: null, disabled_at: null });
    await expect(appUser({ email: "info@intra-ai.de" })).rejects.toMatchObject({ code: "23505" });
    const found = await database.pool.query("SELECT role FROM auth.app_user WHERE email = 'INFO@intra-ai.de'");
    expect(found.rows).toEqual([{ role: "admin" }]);
  });

  it.each([
    ["app_user_role_known", { role: "viewer" }],
    ["app_user_status_known", { status: "gone" }],
    ["app_user_disabled_at", { status: "disabled" }],
    ["app_user_disabled_at", { disabled_at: new Date("2026-10-21T10:00:00Z") }],
    ["app_user_email_format", { email: "no-at-sign" }],
    ["app_user_email_format", { email: "two@at@signs.de" }],
    ["app_user_email_format", { email: `${"x".repeat(250)}@a.de` }],
  ])("refuses a person against %s (%j)", async (constraint, overrides) => {
    await expect(appUser(overrides)).rejects.toMatchObject({ code: "23514", constraint });
  });

  let attemptCount = 0;

  async function loginAttempt(overrides: Row = {}): Promise<Row> {
    attemptCount += 1;
    return insert("auth.login_attempt", {
      ref: "K7QF",
      attempt_hash: `attempt-${attemptCount}`,
      email_mac: "email-mac",
      code_mac: "code-mac",
      expires_at: new Date("2026-10-21T10:10:00Z"),
      ip: "203.0.113.7",
      user_agent: "Firefox",
      ...overrides,
    });
  }

  it("keeps a login attempt for any address, with its reference and no tries yet", async () => {
    const user = await appUser();
    const known = await loginAttempt({ user_id: user.id });
    const unknown = await loginAttempt();

    expect(known).toMatchObject({ failed_tries: 0, used_at: null, closed_at: null, device_id: null, ip: "203.0.113.7" });
    expect(unknown.user_id).toBeNull();
    await expect(loginAttempt({ attempt_hash: known.attempt_hash })).rejects.toMatchObject({ code: "23505" });
  });

  it.each([
    ["login_attempt_ref_format", { ref: "KBQF" }],
    ["login_attempt_ref_format", { ref: "k7qf" }],
    ["login_attempt_failed_tries_range", { failed_tries: 4 }],
    ["login_attempt_failed_tries_range", { failed_tries: -1 }],
  ])("refuses a login attempt against %s (%j)", async (constraint, overrides) => {
    await expect(loginAttempt(overrides)).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("keeps sessions by token hash, ended ones with a reason", async () => {
    const user = await appUser();
    const session: Row = {
      token_hash: "token-1",
      user_id: user.id,
      csrf_secret: "csrf",
      last_seen_at: new Date("2026-10-21T10:00:00Z"),
      expires_at: new Date("2026-10-28T10:00:00Z"),
      ip: "203.0.113.7",
    };
    const row = await insert("auth.session", session);

    expect(row).toMatchObject({ ended_at: null, end_reason: null, user_agent: null });
    expect(row.created_at).toBeInstanceOf(Date);
    await expect(insert("auth.session", session)).rejects.toMatchObject({ code: "23505" });
    await insert("auth.session", { ...session, token_hash: "token-2", ended_at: new Date(), end_reason: "logout" });
    await expect(
      insert("auth.session", { ...session, token_hash: "token-3", user_id: "00000000-0000-7000-8000-000000000001" }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it.each([
    ["session_ended_reason", { ended_at: new Date("2026-10-21T11:00:00Z") }],
    ["session_ended_reason", { end_reason: "logout" }],
    ["session_ended_reason", { ended_at: new Date("2026-10-21T11:00:00Z"), end_reason: "Logged Out" }],
  ])("refuses a session against %s (%j)", async (constraint, overrides) => {
    const user = await appUser();

    await expect(
      insert("auth.session", {
        token_hash: `token-${String(userCount)}`,
        user_id: user.id,
        csrf_secret: "csrf",
        last_seen_at: new Date("2026-10-21T10:00:00Z"),
        expires_at: new Date("2026-10-28T10:00:00Z"),
        ...overrides,
      }),
    ).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("keeps device cookies by token hash for one person, and lets a login attempt name its device", async () => {
    const user = await appUser();
    const device = await insert("auth.device", {
      user_id: user.id,
      token_hash: "device-1",
      last_used_at: new Date("2026-10-21T10:00:00Z"),
    });

    expect(device).toMatchObject({ revoked_at: null });
    await expect(
      insert("auth.device", { user_id: user.id, token_hash: "device-1", last_used_at: new Date("2026-10-21T10:00:00Z") }),
    ).rejects.toMatchObject({ code: "23505" });
    await loginAttempt({ user_id: user.id, device_id: device.id });
    await expect(loginAttempt({ device_id: "00000000-0000-7000-8000-000000000001" })).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("counts rate limits per key and window", async () => {
    const windowStart = new Date("2026-10-21T10:00:00Z");
    await insert("auth.rate_counter", { key: "code_request:ip:abc", window_start: windowStart, count: 1 });

    await expect(
      insert("auth.rate_counter", { key: "code_request:ip:abc", window_start: windowStart, count: 1 }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      insert("auth.rate_counter", { key: "code_request:ip:abc", window_start: new Date(), count: -1 }),
    ).rejects.toMatchObject({ code: "23514", constraint: "rate_counter_count" });
    await expect(insert("auth.rate_counter", { key: "", window_start: windowStart, count: 1 })).rejects.toMatchObject({
      code: "23514",
      constraint: "rate_counter_key_length",
    });
  });

  it("records the auth events of spec 7.12 and refuses others", async () => {
    const at = new Date("2026-10-21T10:00:00Z");
    for (const event of [
      "login_code_requested",
      "login_code_capped",
      "login_succeeded",
      "login_failed",
      "login_locked",
      "login_mail_failed",
      "session_ended",
      "sign_out_everywhere",
      "login_code_cli",
      "device_revoked",
    ]) {
      await insert("auth.auth_event", { at, event, email_mac: "mac", ip: "203.0.113.7" });
    }
    const row = await insert("auth.auth_event", { at, event: "login_succeeded" });

    expect(row).toMatchObject({ user_id: null, email_mac: null, ip: null, detail: {} });
    await expect(insert("auth.auth_event", { at, event: "login_guessed" })).rejects.toMatchObject({
      code: "23514",
      constraint: "auth_event_event_known",
    });
  });
});

describe("widened checks (spec 2.9) and the new candidate columns (2.8)", () => {
  it("lets user:<uuid> act in audit_event and still refuses an actor without a kind", async () => {
    const event = (actor: string) =>
      insert("app.audit_event", { at: new Date("2026-10-21T10:00:00Z"), actor, action: "product.created" });
    await event("user:0190f7a2-3c4d-7e5f-8a6b-1c2d3e4f5a6b");
    await event("system:import");

    await expect(event("simon")).rejects.toMatchObject({ code: "23514", constraint: "audit_event_actor_format" });
  });

  const candidate = (n: number, overrides: Row = {}): Row => ({
    item_key: String(n).padStart(64, "0"),
    listing_id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    feed_id: "s1",
    segment: "p_abcdefghij",
    source: "poll",
    shipping_known: true,
    rule_version: 1,
    ...overrides,
  });

  it("takes the decisions wrong_product and held with the v2 columns, all null on an old-style row", async () => {
    const old = await insert("app.candidate", candidate(1));
    await insert("app.candidate", candidate(2, { decision: "wrong_product" }));
    const held = await insert(
      "app.candidate",
      candidate(3, {
        decision: "held",
        held_reason: "claude_cap",
        product_version: 3,
        match_version: 2,
        condition_group: "used",
        limit_cents: 52_000,
        price_mode: "below_market",
        market_value_id: "00000000-0000-7000-8000-000000000009",
        prompt_version: "screening-v2",
        model: "claude-sonnet-5-5",
        effort: "medium",
      }),
    );

    expect(old).toMatchObject({
      product_version: null,
      match_version: null,
      condition_group: null,
      limit_cents: null,
      price_mode: null,
      market_value_id: null,
      prompt_version: null,
      model: null,
      effort: null,
      held_reason: null,
    });
    expect(held).toMatchObject({ decision: "held", held_reason: "claude_cap", limit_cents: 52_000 });
  });

  it.each([
    ["candidate_decision_known", { decision: "maybe" }],
    ["candidate_price_mode_known", { price_mode: "market" }],
    ["candidate_condition_group_known", { condition_group: "broken" }],
    ["candidate_held_reason_format", { held_reason: "Claude Cap" }],
    ["candidate_versions_positive", { product_version: 0 }],
    ["candidate_versions_positive", { match_version: 0 }],
    ["candidate_limit_positive", { limit_cents: 0 }],
  ])("refuses a candidate against %s (%j)", async (constraint, overrides) => {
    await expect(insert("app.candidate", candidate(9, overrides))).rejects.toMatchObject({ code: "23514", constraint });
  });

  it("counts Claude calls per product and Berlin day (spec 4.4)", async () => {
    const usage = (row: Row) => insert("app.llm_usage_product_daily", { day_berlin: "2026-10-21", product_key: "gpu_3090", ...row });
    const first = await usage({});

    expect(first.calls).toBe(0);
    await expect(usage({ calls: 1 })).rejects.toMatchObject({ code: "23505" });
    await expect(usage({ product_key: "ram_ddr5", calls: -1 })).rejects.toMatchObject({
      code: "23514",
      constraint: "llm_usage_product_daily_calls",
    });
  });
});
