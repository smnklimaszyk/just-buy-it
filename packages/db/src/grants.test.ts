import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { runPurge } from "./purge.js";
import { migrateQueue } from "./queue/migrate-queue.js";
import { AUTH_RETENTION, RETENTION } from "./retention.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Sections 2.5 and 8.2: the worker and dashboard roles get exactly these rights (migration 0005).

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

// "schema.table PRIVILEGE" for every table-level grant to the role, in every schema.
async function tableGrants(role: string): Promise<string[]> {
  const result = await database.pool.query<{ grant: string }>(
    `SELECT n.nspname || '.' || c.relname || ' ' || a.privilege_type AS grant
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
      ORDER BY 1`,
    [role],
  );
  return result.rows.map((row) => row.grant);
}

const grantsOn = (tables: readonly string[], privileges: readonly string[]): string[] =>
  tables.flatMap((table) => privileges.map((privilege) => `${table} ${privilege}`));

const WORKER_PURGED = RETENTION.filter((rule) => rule.purgedByWorker).map((rule) => `${rule.schema}.${rule.table}`);
// Purged by the worker, but rows it only works on (spec 2.10): no INSERT and only column UPDATEs.
const WORKER_PURGED_LIMITED = ["app.market_value", "app.market_request", "app.category_request"];
const WORKER_KEPT = ["app.screening_pause", "app.smtp_pause", "app.worker_status", "app.market_daily"];
const CONFIG = [
  "app.feed",
  "app.segment_rule",
  "app.product",
  "app.product_source",
  "app.product_revision",
  "app.search",
  "app.search_product",
  "app.setting",
];
const AUTH_PURGED = AUTH_RETENTION.filter((rule) => rule.purgedByWorker).map((rule) => `auth.${rule.table}`);

describe("worker role", () => {
  it("may change its own tables, delete only from the tables its purge covers, and read the config", async () => {
    const full = WORKER_PURGED.filter((table) => !WORKER_PURGED_LIMITED.includes(table));
    const expected = [
      ...grantsOn(full, ["SELECT", "INSERT", "UPDATE", "DELETE"]),
      ...grantsOn(["app.market_value"], ["SELECT", "INSERT", "DELETE"]),
      ...grantsOn(["app.market_request", "app.category_request"], ["SELECT", "DELETE"]),
      ...grantsOn(WORKER_KEPT, ["SELECT", "INSERT", "UPDATE"]),
      ...grantsOn(CONFIG, ["SELECT"]),
      ...grantsOn(["app.ebay_quota_window", "app.api_usage_hourly"], ["SELECT", "INSERT", "UPDATE"]),
      ...grantsOn(AUTH_PURGED, ["DELETE"]),
    ].sort();

    expect(full.length).toBe(18);
    expect(await tableGrants("worker")).toEqual(expected);
  });

  it("reads only id, email and status of people, the purge keys of the auth tables, and updates single columns", async () => {
    const select = (table: string, columns: readonly string[]) => columns.map((column) => `${table}.${column} SELECT`);
    const update = (table: string, columns: readonly string[]) => columns.map((column) => `${table}.${column} UPDATE`);
    // ctid, because the purge deletes in batches by ctid (purge.ts).
    const expected = [
      ...select("auth.app_user", ["id", "email", "status"]),
      ...select("auth.login_attempt", ["ctid", "created_at"]),
      ...select("auth.session", ["ctid", "ended_at", "expires_at"]),
      ...select("auth.device", ["ctid", "last_used_at", "revoked_at"]),
      ...select("auth.rate_counter", ["ctid", "window_start"]),
      ...select("auth.auth_event", ["ctid", "at"]),
      ...update("app.market_value", ["m_cents", "p25_cents", "p75_cents", "lo_cents", "hi_cents", "value_cents"]),
      ...update("app.market_request", ["status", "done_at"]),
      ...update("app.category_request", ["status", "result", "done_at"]),
      ...update("app.product", ["category_name"]),
    ].sort();

    expect(await columnGrants("worker")).toEqual(expected);
  });
});

// "schema.table.column PRIVILEGE" for every column-level grant to the role.
async function columnGrants(role: string): Promise<string[]> {
  const result = await database.pool.query<{ grant: string }>(
    `SELECT n.nspname || '.' || c.relname || '.' || at.attname || ' ' || a.privilege_type AS grant
       FROM pg_attribute at
       JOIN pg_class c ON c.oid = at.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(at.attacl) a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
      ORDER BY 1`,
    [role],
  );
  return result.rows.map((row) => row.grant);
}

const columnsOf = (table: string, columns: readonly string[]): string[] =>
  columns.map((column) => `${table}.${column} SELECT`);

describe("dashboard role", () => {
  it("may read exactly the tables and columns of section 8.2", async () => {
    const tables = [
      "app.feed",
      "app.segment_rule",
      "app.poll_run",
      "app.candidate",
      "app.screening",
      "app.llm_usage_daily",
      "app.alert",
      "app.alert_delivery",
      "app.price_sample",
      "app.purge_run",
      "app.worker_status",
      "app.screening_pause",
      "app.smtp_pause",
      "app.api_usage_hourly",
      "ebay_live.classifier_sample",
      "ebay_live.screening_text",
    ];
    const columns = [
      ...columnsOf("app.seen_item", ["feed_id", "segment", "outcome", "first_seen_at", "last_seen_at"]),
      ...columnsOf("app.ebay_quota_window", [
        "resource",
        "window_start",
        "window_end",
        "limit_total",
        "used",
        "used_alert_path",
        "used_standard",
      ]),
      ...columnsOf("ebay_live.listing", ["id", "legacy_item_id", "segment", "content_expires_at", "gone_at"]),
      ...columnsOf("ebay_live.listing_content", ["listing_id", "title", "content_expires_at"]),
    ];

    expect(await tableGrants("dashboard")).toEqual(grantsOn(tables, ["SELECT"]).sort());
    expect(await columnGrants("dashboard")).toEqual(columns.sort());
  });
});

const OLD = new Date("2025-01-01T00:00:00.000Z");
const KEY = "d".repeat(64);
const LISTING_ID = "00000000-0000-7000-8000-0000000000a1";

// One old row in every table of app, auth and ebay_live, written as the owner.
async function fillEveryTable(): Promise<void> {
  const q = (statement: string, params: unknown[] = []) => database.pool.query(statement, params);
  await q("INSERT INTO app.api_usage_hourly (hour_utc, resource, purpose, calls) VALUES ($1, 'buy.browse', 'poll', 1)", [OLD]);
  await q("INSERT INTO app.deletion_event (notification_id, topic, event_date, publish_attempt_count) VALUES ('n', 't', $1, 1)", [OLD]);
  await q("INSERT INTO app.deletion_result_hourly (hour_utc, result, notifications) VALUES ($1, 'dropped', 1)", [OLD]);
  await q("INSERT INTO app.ebay_quota_window (resource, window_start, window_end) VALUES ('buy.browse', $1, $1::timestamptz + interval '1 day')", [OLD]);
  await q("INSERT INTO app.probe_seen (seen_at) VALUES ($1)", [OLD]);
  await q("INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at) VALUES ($1, 1, 's1', 'baseline', $2, $2)", [KEY, OLD]);
  await q("INSERT INTO app.price_sample (segment, feed_id, price_cents, seen_at) VALUES ('p_abcdefghij', 's1', 1, $1)", [OLD]);
  await q("INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status) VALUES ('s1', 'poll', $1, $1, 'ok')", [OLD]);
  const candidate = await q(
    `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, price_cents, shipping_known, rule_version, created_at, decision)
     VALUES ($1, $2, 's1', 'p_abcdefghij', 'poll', 100, true, 1, $3, 'wrong_product') RETURNING id`,
    [KEY, LISTING_ID, OLD],
  );
  const screening = await q(
    "INSERT INTO app.screening (item_key, prompt_version, model, status, created_at) VALUES ($1, 'v', 'm', 'skipped', $2) RETURNING id",
    [KEY, OLD],
  );
  await q("INSERT INTO app.screening_pause (until) VALUES ($1)", [OLD]);
  await q("INSERT INTO app.llm_usage_daily (day_berlin, calls) VALUES ('2025-01-01', 1)");
  const alert = await q(
    `INSERT INTO app.alert (item_key, candidate_id, segment, final_verdict, blocked_by_code, screened, rule_version, buyer_profile, created_at)
     VALUES ($1, $2, 'p_abcdefghij', 'pass', false, true, 1, 'company', $3) RETURNING id`,
    [KEY, candidate.rows[0]?.id, OLD],
  );
  const delivery = await q(
    "INSERT INTO app.alert_delivery (alert_id, recipient, next_attempt_at, created_at) VALUES ($1, 'r', $2, $2) RETURNING id",
    [alert.rows[0]?.id, OLD],
  );
  await q("INSERT INTO app.smtp_pause (until) VALUES ($1)", [OLD]);
  await q("INSERT INTO app.purge_run (started_at, finished_at, status) VALUES ($1, $1, 'ok')", [OLD]);
  await q("INSERT INTO app.worker_status (git_sha, started_at, heartbeat_at, smtp_configured, claude_configured) VALUES ('x', $1, $1, false, false)", [OLD]);
  await q("INSERT INTO app.audit_event (at, actor, action) VALUES ($1, 'system:cli', 'x')", [OLD]);
  const product = await q(
    `INSERT INTO app.product (key, name, description, category_id, condition_ids, search_words, must_words, price_mode,
       max_cents, sweep_minute, buyer_profile)
     VALUES ('p_abcdefghij', 'n', 'd', '27386', '{3000}', '{w}', '[["w"]]', 'fixed', 100, 1, 'company') RETURNING id`,
  );
  const productId: unknown = product.rows[0]?.id;
  await q("INSERT INTO app.product_source (product_id, source, enabled) VALUES ($1, 'ebay', true)", [productId]);
  await q("INSERT INTO app.product_revision (product_id, version, rules, actor) VALUES ($1, 1, '{}', 'system:cli')", [productId]);
  await q(
    `INSERT INTO app.search (id, category_id, condition_ids, q, floor_eur, ceiling_eur, day_interval_s, night_interval_s, enabled, members_hash)
     VALUES ('s1', '27386', '{3000}', 'w', 0, 2, 300, 600, true, 'h')`,
  );
  await q("INSERT INTO app.search_product (search_id, product_id) VALUES ('s1', $1)", [productId]);
  await q("INSERT INTO app.setting (key, value) VALUES ('claude.model', '\"claude-sonnet-5-5\"')");
  await q(
    `INSERT INTO app.market_listing (product_id, match_version, source, item_key, condition_group, landed_cents, first_seen_at, last_seen_at, best_offer)
     VALUES ($1, 1, 'ebay', $2, 'used', 100, $3, $3, false)`,
    [productId, KEY, OLD],
  );
  await q(
    `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped, n, neff, value_cents)
     VALUES ($1, 'used', 1, $2, 'mv-1', 'ok', false, 9, 9, 100)`,
    [productId, OLD],
  );
  await q("INSERT INTO app.market_request (product_id, reason, requested_at, status, done_at) VALUES ($1, 'created', $2, 'done', $2)", [productId, OLD]);
  await q("INSERT INTO app.category_request (q, status, done_at, created_at) VALUES ('w', 'done', $1, $1)", [OLD]);
  await q("INSERT INTO app.market_daily (day_berlin, extra_snapshots) VALUES ('2025-01-01', 1)");
  await q("INSERT INTO app.market_run (product_id, started_at, finished_at, status) VALUES ($1, $2, $2, 'ok')", [productId, OLD]);
  await q("INSERT INTO app.llm_usage_product_daily (day_berlin, product_key, calls) VALUES ('2025-01-01', 'p_abcdefghij', 1)");
  await q(
    `INSERT INTO ebay_live.listing (id, item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at, last_confirmed_at, content_expires_at)
     VALUES ($1, $2, 1, 'v1|1|0', '1', 's1', 'p_abcdefghij', $3, $3, $3)`,
    [LISTING_ID, KEY, OLD],
  );
  await q("INSERT INTO ebay_live.listing_content (listing_id, source, title, fetched_at, content_expires_at) VALUES ($1, 'summary', 't', $2, $2)", [LISTING_ID, OLD]);
  await q("INSERT INTO ebay_live.classifier_sample (feed_id, title, outcome, seen_at, expires_at) VALUES ('s1', 't', 'candidate', $1, $1)", [OLD]);
  await q("INSERT INTO ebay_live.screening_text (screening_id, reason, expires_at) VALUES ($1, 'r', $2)", [screening.rows[0]?.id, OLD]);
  await q("INSERT INTO ebay_live.alert_message (delivery_id, subject, text_body, html_body, expires_at) VALUES ($1, 's', 't', 'h', $2)", [delivery.rows[0]?.id, OLD]);
  await q(
    "INSERT INTO ebay_live.market_preview (product_id, item_key, legacy_item_id, title, outcome, seen_at) VALUES ($1, $2, '1', 't', 'counted', $3)",
    [productId, KEY, OLD],
  );
  const user = await q("INSERT INTO auth.app_user (email, role) VALUES ('purge@example.org', 'admin') RETURNING id");
  const userId: unknown = user.rows[0]?.id;
  const device = await q("INSERT INTO auth.device (user_id, token_hash, last_used_at, revoked_at, created_at) VALUES ($1, 'd', $2, $2, $2) RETURNING id", [userId, OLD]);
  await q(
    `INSERT INTO auth.login_attempt (ref, attempt_hash, user_id, device_id, email_mac, code_mac, created_at, expires_at)
     VALUES ('K7QF', 'a', $1, $2, 'e', 'c', $3, $3)`,
    [userId, device.rows[0]?.id, OLD],
  );
  await q(
    "INSERT INTO auth.session (token_hash, user_id, csrf_secret, last_seen_at, expires_at, ended_at, end_reason, created_at) VALUES ('t', $1, 's', $2, $2, $2, 'logout', $2)",
    [userId, OLD],
  );
  await q("INSERT INTO auth.rate_counter (key, window_start, count) VALUES ('k', $1, 1)", [OLD]);
  await q("INSERT INTO auth.auth_event (at, event) VALUES ($1, 'login_succeeded')", [OLD]);
}

describe("runPurge and the v2 purge targets as worker (spec 2.10)", () => {
  it("runs the purge with a row in every table, and lets the worker delete by purge key from every table it purges", async () => {
    await fillEveryTable();
    const counts = await database.pool.query<{ name: string; rows: number }>(
      `SELECT format('%s.%s', table_schema, table_name) AS name,
              (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::int AS rows
         FROM information_schema.tables
        WHERE table_schema IN ('app', 'auth', 'ebay_live') AND table_type = 'BASE TABLE'`,
    );
    expect(counts.rows.length).toBe(45);
    expect(counts.rows.filter((row) => row.rows === 0)).toEqual([]);

    const worker = await database.pool.connect();
    try {
      await worker.query("SET ROLE worker");
      const failedSteps: string[] = [];
      await runPurge(worker, { now: () => new Date("2026-10-21T12:00:00.000Z") }, { onStepError: (step) => failedSteps.push(step) });
      expect(failedSteps).toEqual([]);

      const purged = [...RETENTION, ...AUTH_RETENTION].filter((rule) => rule.purgedByWorker && rule.purgeKey !== null);
      for (const rule of purged) {
        const table = `${rule.schema}.${rule.table}`;
        await worker.query("BEGIN");
        try {
          await worker.query(
            `DELETE FROM ${table} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${table} WHERE ${rule.purgeKey ?? ""} <= $1 LIMIT 10))`,
            [new Date("2026-01-01T00:00:00.000Z")],
          );
        } finally {
          await worker.query("ROLLBACK");
        }
      }
      await worker.query("BEGIN");
      try {
        await worker.query("DELETE FROM auth.device WHERE ctid = ANY (ARRAY(SELECT ctid FROM auth.device WHERE last_used_at <= $1 LIMIT 10))", [OLD]);
        await worker.query(
          `UPDATE app.market_value SET m_cents = NULL, p25_cents = NULL, p75_cents = NULL, lo_cents = NULL, hi_cents = NULL, value_cents = NULL
            WHERE ctid = ANY (ARRAY(SELECT ctid FROM app.market_value WHERE computed_at <= $1 AND value_cents IS NOT NULL LIMIT 10))`,
          [OLD],
        );
      } finally {
        await worker.query("ROLLBACK");
      }
      expect(purged.length).toBe(26);
    } finally {
      await worker.query("RESET ROLE");
      worker.release();
    }
  });
});

// The read tables of today's dashboard (section 8.2), which the admin UI shows too.
const DASHBOARD_TABLES = [
  "app.feed",
  "app.segment_rule",
  "app.poll_run",
  "app.candidate",
  "app.screening",
  "app.llm_usage_daily",
  "app.alert",
  "app.alert_delivery",
  "app.price_sample",
  "app.purge_run",
  "app.worker_status",
  "app.screening_pause",
  "app.smtp_pause",
  "app.api_usage_hourly",
  "ebay_live.classifier_sample",
  "ebay_live.screening_text",
];

describe("web role (spec 2.10)", () => {
  it("reads the dashboard tables and every new table, and writes only the config, requests and sign-in rows", async () => {
    const read = [
      "app.market_listing",
      "app.market_value",
      "app.market_daily",
      "app.market_run",
      "app.llm_usage_product_daily",
      "app.product_revision",
      "app.audit_event",
      "ebay_live.market_preview",
      "auth.auth_event",
    ];
    const expected = [
      ...grantsOn([...DASHBOARD_TABLES, ...read], ["SELECT"]),
      ...grantsOn(
        ["app.product", "app.product_source", "app.search", "app.setting", "app.market_request", "app.category_request"],
        ["SELECT", "INSERT", "UPDATE"],
      ),
      ...grantsOn(["app.search_product"], ["SELECT", "INSERT", "DELETE"]),
      ...grantsOn(["app.product_revision", "app.audit_event", "auth.auth_event"], ["INSERT"]),
      ...grantsOn(
        ["auth.app_user", "auth.login_attempt", "auth.session", "auth.device", "auth.rate_counter"],
        ["SELECT", "INSERT", "UPDATE"],
      ),
      "app.search_id_seq USAGE",
    ].sort();
    const dashboardColumns = await columnGrants("dashboard");
    const roles = await database.pool.query<{ rolconfig: string[]; rolcanlogin: boolean; rolsuper: boolean }>(
      "SELECT rolconfig, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = 'web'",
    );

    expect(await tableGrants("web")).toEqual(expected);
    expect(await columnGrants("web")).toEqual(dashboardColumns);
    expect(roles.rows.map((row) => [row.rolconfig, row.rolsuper])).toEqual([[["statement_timeout=2s"], false]]);
  });

  it("is refused deletes on its sign-in trail, the deletion tables, pg-boss and the eBay call reservation", async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      await migrateQueue(client);
    } finally {
      await client.end();
    }
    const rights = await database.pool.query<{ pgboss: boolean; reserve: boolean; worker_reserve: boolean }>(
      `SELECT has_schema_privilege('web', 'pgboss', 'USAGE') AS pgboss,
              has_function_privilege('web', 'app.reserve_ebay_call(text, text, text, integer, timestamptz)', 'EXECUTE') AS reserve,
              has_function_privilege('worker', 'app.reserve_ebay_call(text, text, text, integer, timestamptz)', 'EXECUTE') AS worker_reserve`,
    );

    expect(rights.rows[0]).toEqual({ pgboss: false, reserve: false, worker_reserve: true });
    for (const statement of [
      ...["app_user", "login_attempt", "session", "device", "rate_counter", "auth_event"].map(
        (table) => `DELETE FROM auth.${table}`,
      ),
      "UPDATE auth.auth_event SET event = 'login_failed'",
      "DELETE FROM app.audit_event",
      "UPDATE app.product_revision SET actor = 'system:cli'",
      "DELETE FROM app.product",
      "DELETE FROM app.search",
      "SELECT * FROM app.deletion_event",
      "SELECT * FROM app.deletion_result_hourly",
      "SELECT * FROM app.probe_seen",
      "SELECT item_key FROM app.seen_item",
      "SELECT 1 FROM pgboss.job",
      "SELECT app.reserve_ebay_call('buy.browse', 'standard', 'web', 0, now())",
      "UPDATE app.ebay_quota_window SET used = used",
      "INSERT INTO app.llm_usage_daily (day_berlin) VALUES ('2026-10-21')",
      "INSERT INTO app.llm_usage_product_daily (day_berlin, product_key) VALUES ('2026-10-21', 'x')",
      "UPDATE app.market_value SET value_cents = 1",
      "INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, shipping_known, rule_version) VALUES ('k', gen_random_uuid(), 's1', 'x', 'poll', true, 1)",
    ]) {
      expect(await asRole("web", statement), statement).toMatchObject({ code: "42501" });
    }
  });
});

async function asRole(role: string, statement: string): Promise<unknown> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(statement);
    return null;
  } catch (error) {
    return error;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("both roles", () => {
  it("use both schemas, keep their role defaults, and are refused what section 2.5 leaves out", async () => {
    const settings = await database.pool.query<{ rolname: string; rolconfig: string[]; rolcanlogin: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolconfig, rolcanlogin, rolsuper FROM pg_roles WHERE rolname IN ('worker', 'dashboard') ORDER BY rolname",
    );
    const execute = await database.pool.query<{ worker: boolean; dashboard: boolean }>(
      `SELECT has_function_privilege('worker', 'app.reserve_ebay_call(text, text, text, integer, timestamptz)', 'EXECUTE') AS worker,
              has_schema_privilege('dashboard', 'ebay_live', 'USAGE') AND has_schema_privilege('worker', 'ebay_live', 'USAGE')
                AND NOT has_schema_privilege('dashboard', 'app', 'CREATE') AS dashboard`,
    );

    expect(settings.rows.map((row) => [row.rolname, [...row.rolconfig].sort(), row.rolsuper])).toEqual([
      ["dashboard", ["default_transaction_read_only=on", "statement_timeout=2s"], false],
      ["worker", ["statement_timeout=10s"], false],
    ]);
    expect(execute.rows[0]).toEqual({ worker: true, dashboard: true });
    for (const [role, statement] of [
      ["dashboard", "INSERT INTO app.feed (id, category_id, q, price_ceiling_cents, condition_ids, day_interval_s, night_interval_s) VALUES ('gpu', '1', 'x', 1, '{}', 60, 60)"],
      ["dashboard", "SELECT * FROM app.deletion_event"],
      ["dashboard", "SELECT item_key FROM app.seen_item"],
      ["dashboard", "SELECT item_key FROM ebay_live.listing"],
      ["dashboard", "SELECT subject FROM ebay_live.alert_message"],
      ["dashboard", "SELECT * FROM app.audit_event"],
      ["worker", "SELECT * FROM app.deletion_event"],
      ["worker", "SELECT * FROM app.audit_event"],
      ["worker", "UPDATE app.segment_rule SET enabled = false"],
      ["worker", "DELETE FROM app.worker_status"],
      ["worker", "DELETE FROM app.api_usage_hourly"],
    ] as const) {
      expect(await asRole(role, statement), `${role}: ${statement}`).toMatchObject({ code: "42501" });
    }
  });
});
