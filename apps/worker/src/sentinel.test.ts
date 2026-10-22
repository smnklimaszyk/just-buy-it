import { QUEUES, type JobQueue, type QueueName } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMailTest } from "./cli.js";
import { parseEnv } from "./env.js";
import { CLAUDE_TEST_KEY, createFakeClaude } from "./testing/claude.js";
import { createTestClock } from "./testing/clock.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";
import { createFakeEbay, createFakeReserve, fakeLegacyItemId, gpuSummary, searchPage } from "./testing/ebay.js";
import { createTestLog } from "./testing/log.js";
import { resetTables, startTestQueue } from "./testing/queue.js";
import { createFakeSmtp, SMTP_TEST_PASSWORD } from "./testing/smtp.js";
import { createWiring } from "./wiring.js";

// Section 10, sentinel (A23 and secrets): a seller username, the Claude key and the SMTP password
// go through the whole flow, including a Claude 401 whose body echoes the key and an SMTP EAUTH
// whose error carries the password. None of them may come out anywhere.

const SELLER_SENTINEL = "SENTINEL_SELLER_7f3a";
const SMTP_USER = "alerts@example.test";
// The password as the AUTH PLAIN exchange sends it, and alone in base64.
const AUTH_PLAIN = Buffer.from(`\0${SMTP_USER}\0${SMTP_TEST_PASSWORD}`).toString("base64");
const SECRETS = [CLAUDE_TEST_KEY, SMTP_TEST_PASSWORD, AUTH_PLAIN, Buffer.from(SMTP_TEST_PASSWORD).toString("base64")];

// 12:00 CEST.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const HOUR_MS = 3_600_000;

const ENV = {
  DATABASE_URL: "postgres://worker:unused@127.0.0.1:1/unused",
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  EBAY_ENVIRONMENT: "production",
  EBAY_CLIENT_ID: "fake-client-id",
  EBAY_CLIENT_SECRET: "fake-client-secret",
  ITEM_KEY_V1: Buffer.alloc(32, 5).toString("base64"),
  ALERT_TO: "owner@example.test",
  ANTHROPIC_API_KEY: CLAUDE_TEST_KEY,
  SMTP_HOST: "smtp.test",
  SMTP_PORT: "587",
  SMTP_USER,
  SMTP_PASSWORD: SMTP_TEST_PASSWORD,
  ALERT_FROM: "Just-Buy-It <alerts@example.test>",
};

let db: TestDatabase;
let queue: JobQueue;

vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
  db = await createTestDatabase();
  queue = await startTestQueue(db);
}, 60_000);

afterAll(async () => {
  await queue.stop({ graceful: false, timeoutMs: 5_000 });
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await resetTables(db);
  await db.admin.query("UPDATE app.feed SET enabled = true");
  // Past the gpu feed's baseline poll.
  await db.admin.query(
    `INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at)
     VALUES ($1, 1, 'gpu', 'baseline', $2, $2)`,
    ["f".repeat(64), new Date(NOW.getTime() - HOUR_MS)],
  );
});

// Every row of every table the worker or pg-boss writes, as text.
async function everyRow(): Promise<string> {
  const tables = await db.admin.query<{ name: string }>(
    `SELECT format('%I.%I', table_schema, table_name) AS name FROM information_schema.tables
      WHERE table_schema IN ('app', 'ebay_live', 'pgboss') AND table_type = 'BASE TABLE'`,
  );
  const texts: string[] = [];
  for (const { name } of tables.rows) {
    const result = await db.admin.query<{ row: string }>(`SELECT t::text AS row FROM ${name} t`);
    texts.push(...result.rows.map((r) => r.row));
  }
  return texts.join("\n");
}

// Everything an error carries: message, stack, cause and its JSON form.
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error) ?? String(error);
  return [error.message, error.stack ?? "", errorText(error.cause), JSON.stringify(error), String(error)].join("\n");
}

function setup() {
  const clock = createTestClock(NOW);
  const ebay = createFakeEbay();
  const claude = createFakeClaude();
  const smtp = createFakeSmtp();
  const log = createTestLog();
  const errors: unknown[] = [];
  const wiring = createWiring(parseEnv(ENV), {
    pool: db.pool,
    queue,
    clock,
    log: log.log,
    ebayFetch: ebay.fetchFn,
    claudeFetch: claude.fetchFn,
    createTransport: smtp.createTransport,
    reserve: createFakeReserve().reserve,
  });

  // Runs every queued job of a queue once, with the queue's retries at once.
  async function run(name: QueueName): Promise<void> {
    const taken = await db.admin.query<{ id: string; data: unknown }>(
      `DELETE FROM pgboss.job WHERE id IN (SELECT id FROM pgboss.job WHERE name = $1 AND state = 'created') RETURNING id, data`,
      [name],
    );
    for (const job of taken.rows) {
      for (let retryCount = 0; retryCount <= QUEUES[name].retryLimit; retryCount += 1) {
        try {
          const handler = wiring.handlers[name] as (payload: unknown, job: { id: string; retryCount: number; signal: AbortSignal }) => Promise<void>;
          await handler(QUEUES[name].parse(job.data), { id: job.id, retryCount, signal: new AbortController().signal });
          break;
        } catch (error) {
          errors.push(error);
        }
      }
    }
  }

  return { ebay, claude, smtp, log, errors, wiring, run };
}

describe("sentinel: seller username and secrets through the whole flow (A23, section 10)", () => {
  it("keeps the seller username out of every table, the log, the Claude request and the email, and the secrets out of every log line", async () => {
    const { ebay, claude, smtp, log, errors, run } = setup();
    const legacyItemId = fakeLegacyItemId();
    const created = new Date(NOW.getTime() - HOUR_MS).toISOString();
    const seller = { username: SELLER_SENTINEL, feedbackScore: 250, feedbackPercentage: "99.5", sellerAccountType: "INDIVIDUAL" };
    ebay.searchPages(searchPage([gpuSummary({ legacyItemId, price: "450.00", shipping: "10.00", itemCreationDate: created, seller })]));
    ebay.item(`v1|${legacyItemId}|0`, {
      itemId: `v1|${legacyItemId}|0`,
      legacyItemId,
      title: "RTX 3090 Founders Edition 24GB",
      price: { value: "450.00", currency: "EUR" },
      buyingOptions: ["FIXED_PRICE"],
      categoryId: "27386",
      condition: "Gebraucht",
      conditionId: "3000",
      description: "<p>Card works fine, two years of gaming use.</p>",
      shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "10.00", currency: "EUR" } }],
      itemLocation: { country: "DE" },
      seller,
      sellerLegalInfo: { sellerProvidedLegalAddress: { addressLine1: SELLER_SENTINEL } },
      itemCreationDate: created,
      itemEndDate: new Date(NOW.getTime() + 30 * 24 * HOUR_MS).toISOString(),
    });
    // Claude refuses the key and echoes it; the SMTP server refuses the login.
    claude.status(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${CLAUDE_TEST_KEY}` } });
    smtp.reply("auth");

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    await run("send");

    // The flow went all the way: Claude was called, the email reached the transport.
    expect(claude.requests).toHaveLength(1);
    expect(smtp.sent).toHaveLength(1);
    expect(await db.admin.query("SELECT failure_code FROM app.screening").then((r) => r.rows)).toEqual([{ failure_code: "auth_failed" }]);
    expect(await db.admin.query("SELECT last_error_code FROM app.alert_delivery").then((r) => r.rows)).toEqual([{ last_error_code: "EAUTH" }]);

    const tables = await everyRow();
    const logged = log.text();
    const claudeBodies = JSON.stringify(claude.requests.map((r) => r.body));
    const emails = JSON.stringify(smtp.sent);
    for (const text of [tables, logged, claudeBodies, emails]) expect(text).not.toContain(SELLER_SENTINEL);
    for (const secret of SECRETS) {
      expect(logged).not.toContain(secret);
      expect(tables).not.toContain(secret);
      for (const error of errors) expect(errorText(error)).not.toContain(secret);
    }
  });

  it("gives adapter errors that carry neither secret in message, stack, cause or JSON form", async () => {
    const { claude, smtp, wiring } = setup();
    claude.status(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${CLAUDE_TEST_KEY}` } });
    smtp.reply("auth");
    const email = { deliveryId: "0199f0a2-7c1e-7b3a-9d4e-2f6a8b0c1d2e", to: "owner@example.test", subject: "s", text: "t", html: "h" };

    const claudeError: unknown = await wiring.screener?.screen("<listing>{}</listing>").catch((error: unknown) => error);
    const smtpError: unknown = await wiring.mailer?.send(email).catch((error: unknown) => error);

    expect(claudeError).toMatchObject({ code: "auth_failed", status: 401 });
    expect(smtpError).toMatchObject({ kind: "auth", code: "EAUTH" });
    for (const secret of SECRETS) {
      expect(errorText(claudeError)).not.toContain(secret);
      expect(errorText(smtpError)).not.toContain(secret);
    }
  });

  it("has mail:test report a refused SMTP login by its code only and exit 1", async () => {
    const smtp = createFakeSmtp();
    smtp.reply("auth");
    const lines: string[] = [];

    const exitCode = await runMailTest({
      env: parseEnv(ENV),
      createTransport: smtp.createTransport,
      clock: createTestClock(NOW),
      out: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines).toEqual(["mail:test: failed, EAUTH, SMTP 535"]);
    for (const secret of SECRETS) expect(lines.join("\n")).not.toContain(secret);
  });
});
