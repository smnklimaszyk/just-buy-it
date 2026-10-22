import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertWorkerStatus } from "@ebay-sniper/db";
import { QUEUE_NAMES, QUEUES, type JobQueue, type QueueName, type QueuePayloads } from "@ebay-sniper/db/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMailTest, runMain } from "../cli.js";
import { parseEnv } from "../env.js";
import { createHeartbeat } from "../heartbeat.js";
import { createShutdown, SHUTDOWN_TIMING } from "../shutdown.js";
import { createFakeClaude } from "../testing/claude.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, fakeLegacyItemId, gpuSummary, searchPage } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { resetTables, startTestQueue } from "../testing/queue.js";
import { createFakeSmtp, SMTP_TEST_PASSWORD } from "../testing/smtp.js";
import { createWiring, startWorker } from "../wiring.js";

// End to end through the worker wiring (section 10, flow test): poll, enrich, screen, send and
// relay on fake eBay, Claude and SMTP, with the jobs taken from the pg-boss table in order.

// 12:00 CEST.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const ALERT_TO = "owner@example.test";

// The worker's environment as Compose passes it, with fake values.
const ENV = {
  DATABASE_URL: "postgres://worker:unused@127.0.0.1:1/unused",
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  EBAY_ENVIRONMENT: "production",
  EBAY_CLIENT_ID: "fake-client-id",
  EBAY_CLIENT_SECRET: "fake-client-secret",
  ITEM_KEY_V1: Buffer.alloc(32, 9).toString("base64"),
  ALERT_TO,
  ANTHROPIC_API_KEY: "sk-ant-flow-test-key",
  SMTP_HOST: "smtp.test",
  SMTP_PORT: "587",
  SMTP_USER: "alerts@example.test",
  SMTP_PASSWORD: SMTP_TEST_PASSWORD,
  ALERT_FROM: "Just-Buy-It <alerts@example.test>",
};

// Compose passes "" for the unset SMTP variables.
const SMTP_UNSET = { SMTP_HOST: "", SMTP_PORT: "", SMTP_USER: "", SMTP_PASSWORD: "", ALERT_FROM: "" };

let db: TestDatabase;
let queue: JobQueue;

// Each test runs a whole chain of jobs against Postgres.
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
  // The gpu feed has polled before, so the next poll is not a baseline (section 3.2).
  await db.admin.query(
    `INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at)
     VALUES ($1, 1, 'gpu', 'baseline', $2, $2)`,
    ["f".repeat(64), new Date(NOW.getTime() - HOUR_MS)],
  );
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

function setup(env: Record<string, string> = {}) {
  const clock = createTestClock(NOW);
  const ebay = createFakeEbay();
  const claude = createFakeClaude();
  const smtp = createFakeSmtp();
  const reserve = createFakeReserve();
  const log = createTestLog();
  const errors: unknown[] = [];
  const wire = (overrides: Record<string, string>) =>
    createWiring(parseEnv({ ...ENV, ...overrides }), {
      pool: db.pool,
      queue,
      clock,
      log: log.log,
      ebayFetch: ebay.fetchFn,
      claudeFetch: claude.fetchFn,
      createTransport: smtp.createTransport,
      reserve: reserve.reserve,
    });
  let wiring = wire(env);

  // Runs every queued job of a queue once, oldest first, as pg-boss would hand them out. A job that
  // throws on a queue with retries runs again at once with the next retry count.
  async function run(name: QueueName, signal: () => AbortSignal = () => new AbortController().signal): Promise<number> {
    const taken = await rows<{ id: string; data: unknown }>(
      `DELETE FROM pgboss.job WHERE id IN (SELECT id FROM pgboss.job WHERE name = $1 AND state = 'created')
       RETURNING id, data, created_on`,
      [name],
    );
    for (const job of taken) {
      for (let retryCount = 0; retryCount <= QUEUES[name].retryLimit; retryCount += 1) {
        try {
          const handler = wiring.handlers[name] as (payload: unknown, job: { id: string; retryCount: number; signal: AbortSignal }) => Promise<void>;
          await handler(QUEUES[name].parse(job.data), { id: job.id, retryCount, signal: signal() });
          break;
        } catch (error) {
          errors.push(error);
        }
      }
    }
    return taken.length;
  }

  // A scheduled queue's job as its cron would queue it, then run.
  async function tick(name: "relay" | "poll-tick" | "purge"): Promise<void> {
    await queue.send(name, {});
    await run(name);
  }

  // The legacy ID of a new in-band RTX 3090 listing that the next poll finds; getItem answers for it.
  function listing(item: Record<string, unknown> = {}): string {
    const legacyItemId = fakeLegacyItemId();
    const created = new Date(NOW.getTime() - HOUR_MS).toISOString();
    ebay.searchPages(searchPage([gpuSummary({ legacyItemId, price: "450.00", shipping: "10.00", itemCreationDate: created })]));
    ebay.item(`v1|${legacyItemId}|0`, itemBody(legacyItemId, item));
    return legacyItemId;
  }

  return {
    clock,
    ebay,
    claude,
    smtp,
    log,
    errors,
    run,
    tick,
    listing,
    rewire(overrides: Record<string, string>) {
      wiring = wire(overrides);
    },
  };
}

// A getItem body. The seller username is in the raw body on purpose: the schema drops it.
function itemBody(legacyItemId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    itemId: `v1|${legacyItemId}|0`,
    legacyItemId,
    title: "RTX 3090 Founders Edition 24GB",
    price: { value: "450.00", currency: "EUR" },
    buyingOptions: ["FIXED_PRICE"],
    categoryId: "27386",
    condition: "Gebraucht",
    conditionId: "3000",
    conditionDescription: "Light signs of use.",
    description: "<p>Card works fine, two years of gaming use.</p>",
    localizedAspects: [{ name: "Marke", value: "NVIDIA" }],
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "10.00", currency: "EUR" } }],
    itemLocation: { country: "DE" },
    seller: { username: "fake-seller-name", feedbackScore: 250, feedbackPercentage: "99.5", sellerAccountType: "INDIVIDUAL" },
    returnTerms: { returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" } },
    image: { imageUrl: "https://i.ebayimg.test/1.jpg" },
    itemCreationDate: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    itemEndDate: new Date(NOW.getTime() + 30 * 24 * HOUR_MS).toISOString(),
    ...fields,
  };
}

describe("flow: candidate to email (sections 2.3, 2.4, 6)", () => {
  it("takes a new listing from the poll through getItem, Claude and SMTP to one sent email", async () => {
    const { ebay, claude, smtp, log, errors, run, listing } = setup();
    const legacyItemId = listing();

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    expect(await rows("SELECT segment, decision FROM app.candidate"), "the wired poll handler makes the candidate").toEqual([
      { segment: "gpu_3090", decision: "pending" },
    ]);
    await run("enrich");
    expect(await rows("SELECT source FROM ebay_live.listing_content"), "the wired enrich handler stores the getItem content").toEqual([
      { source: "item" },
    ]);
    await run("screen");
    expect(await rows("SELECT status, verdict FROM app.screening"), "the wired screen handler screens with Claude").toEqual([
      { status: "done", verdict: "pass" },
    ]);
    await run("send");
    expect(smtp.sent.map((mail) => mail.to), "the wired send handler hands the email to the SMTP transport").toEqual([ALERT_TO]);

    expect(errors).toEqual([]);
    expect(ebay.requests.filter((r) => r.kind === "get_item")).toHaveLength(1);
    expect(claude.requests).toHaveLength(1);
    expect(smtp.sent).toHaveLength(1);
    const sent = smtp.sent[0];
    expect(sent?.to).toBe(ALERT_TO);
    expect(sent?.from).toEqual({ name: "Just-Buy-It", address: "alerts@example.test" });
    expect(sent?.subject).toBe("[Deal] RTX 3090: EUR 460 incl. shipping (88% of max) - PASS");
    expect(String(sent?.text)).toContain(`Open on eBay:  https://www.ebay.de/itm/${legacyItemId}`);
    expect(await rows("SELECT status, attempt, smtp_message_id FROM app.alert_delivery")).toEqual([
      { status: "sent", attempt: 1, smtp_message_id: "<fake-1@smtp.test>" },
    ]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "alerted" }]);
    expect(log.events("alert_created")).toHaveLength(1);
  });

  it("with the Claude call cap at 0 makes no getItem and no Claude call, and emails a not-screened alert from the summary", async () => {
    const { ebay, claude, smtp, errors, run, listing } = setup({ CLAUDE_DAILY_CALL_LIMIT: "0" });
    listing();

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    expect(await run("screen")).toBe(0);
    await run("send");

    expect(errors).toEqual([]);
    expect(ebay.requests.filter((r) => r.kind === "get_item")).toEqual([]);
    expect(claude.requests).toEqual([]);
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["[Deal] RTX 3090: EUR 460 incl. shipping (88% of max) - NOT SCREENED"]);
    expect(String(smtp.sent[0]?.text)).toContain("Not screened by Claude: cap_reached");
    expect(String(smtp.sent[0]?.text)).toContain("Returns:       not fetched");
    expect(await rows("SELECT screened, final_verdict FROM app.alert")).toEqual([{ screened: false, final_verdict: "caution" }]);
  });

  it("makes no alert when getItem answers 404", async () => {
    const { ebay, claude, errors, run } = setup();
    const created = new Date(NOW.getTime() - HOUR_MS).toISOString();
    // Found by the poll, gone by getItem: the fake answers 404 for an item it does not know.
    ebay.searchPages(searchPage([gpuSummary({ price: "450.00", shipping: "10.00", itemCreationDate: created })]));

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");

    expect(errors).toEqual([]);
    expect(ebay.requests.filter((r) => r.kind === "get_item")).toHaveLength(1);
    expect(await run("screen")).toBe(0);
    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "gone" }]);
    expect(await rows("SELECT gone_reason FROM ebay_live.listing")).toEqual([{ gone_reason: "not_found" }]);
    expect(await rows("SELECT id FROM app.alert")).toEqual([]);
  });

  it("starts from the scheduled poll-tick, which queues the poll of the due feed", async () => {
    const { smtp, errors, run, tick, listing } = setup();
    listing();
    // Only the gpu feed is due: the others are paused.
    await db.admin.query("UPDATE app.feed SET enabled = false WHERE id <> 'gpu'");

    await tick("poll-tick");
    expect(await run("poll"), "the wired poll-tick handler queues the poll").toBe(1);
    await run("enrich");
    await run("screen");
    await run("send");

    expect(errors).toEqual([]);
    expect(smtp.sent).toHaveLength(1);
  });

  it("takes a listing found by the hourly sweep of a segment the same way to an email", async () => {
    const { smtp, errors, run, listing } = setup();
    listing();

    await queue.send("sweep", { segment: "gpu_3090" });
    await run("sweep");
    expect(await rows("SELECT source FROM app.candidate"), "the wired sweep handler makes the candidate").toEqual([{ source: "sweep" }]);
    await run("enrich");
    await run("screen");
    await run("send");

    expect(errors).toEqual([]);
    expect(smtp.sent).toHaveLength(1);
  });

  it("leaves no listing content or message once the scheduled purge runs after the 6-hour lifetime", async () => {
    const { clock, errors, run, tick, listing } = setup();
    listing();
    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    await run("send");

    clock.advance(6 * HOUR_MS);
    await tick("purge");

    expect(errors).toEqual([]);
    expect(await rows("SELECT status FROM app.purge_run"), "the wired purge handler writes its run row").toEqual([{ status: "ok" }]);
    expect(await rows("SELECT listing_id FROM ebay_live.listing_content")).toEqual([]);
    expect(await rows("SELECT delivery_id FROM ebay_live.alert_message")).toEqual([]);
    expect(await rows("SELECT status FROM app.alert_delivery")).toEqual([{ status: "sent" }]);
  });
});

describe("flow: Claude failures (sections 2.4, 5.5)", () => {
  it("after a Claude timeout on attempt 1 the retry takes the released lease at once as attempt 2 and one alert is made", async () => {
    const { claude, smtp, errors, run, listing } = setup();
    listing();
    // Attempt 1 hangs until the job's deadline; the retry gets a pass.
    claude.hang();

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen", () => AbortSignal.timeout(100));
    await run("send");

    expect(errors).toMatchObject([{ code: "timeout" }]);
    expect(claude.requests).toHaveLength(2);
    expect(await rows("SELECT status, attempt, verdict, failure_code FROM app.screening")).toEqual([
      { status: "done", attempt: 2, verdict: "pass", failure_code: null },
    ]);
    expect(await rows("SELECT final_verdict, screened FROM app.alert")).toEqual([{ final_verdict: "pass", screened: true }]);
    expect(smtp.sent).toHaveLength(1);
  });

  it("after a Claude failure on both attempts emails the alert as not screened", async () => {
    const { claude, smtp, errors, run, listing } = setup();
    listing();
    claude.status(503);
    claude.status(529);

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    await run("send");

    expect(errors).toMatchObject([{ code: "provider_unavailable" }]);
    expect(claude.requests).toHaveLength(2);
    expect(await rows("SELECT status, attempt, failure_code FROM app.screening")).toEqual([
      { status: "failed", attempt: 2, failure_code: "provider_unavailable" },
    ]);
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["[Deal] RTX 3090: EUR 460 incl. shipping (88% of max) - NOT SCREENED"]);
    expect(String(smtp.sent[0]?.text)).toContain("Not screened by Claude: provider_unavailable");
  });
});

describe("flow: block routing (sections 5.6, 5.7)", () => {
  it("emails a model-only block marked Claude says block", async () => {
    const { claude, smtp, errors, run, listing } = setup();
    listing();
    claude.answer({ verdict: "block", product_match: "mismatch", risk_flags: ["wrong_model"], reason: "The photos show a different card." });

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    await run("send");

    expect(errors).toEqual([]);
    expect(await rows("SELECT final_verdict, model_verdict, blocked_by_code FROM app.alert")).toEqual([
      { final_verdict: "block", model_verdict: "block", blocked_by_code: false },
    ]);
    expect(smtp.sent.map((mail) => mail.subject)).toEqual(["[Deal] RTX 3090: EUR 460 incl. shipping (88% of max) - CLAUDE SAYS BLOCK"]);
    expect(String(smtp.sent[0]?.text)).toContain("The photos show a different card.");
  });

  it("keeps an alert with an off-platform payment phrase on the dashboard only: no delivery, no email", async () => {
    const { smtp, errors, run, listing } = setup();
    listing({ description: "<p>Zahlung nur per PayPal Freunde, sonst keine Abwicklung.</p>" });

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    expect(await run("send")).toBe(0);

    expect(errors).toEqual([]);
    expect(await rows("SELECT final_verdict, blocked_by_code FROM app.alert")).toEqual([{ final_verdict: "block", blocked_by_code: true }]);
    expect(await rows("SELECT id FROM app.alert_delivery")).toEqual([]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "blocked" }]);
    expect(smtp.sent).toEqual([]);
  });

  // Section 5.6: the scan reads the raw description, before the masking turns the IBAN into [IBAN].
  it("keeps an alert with a code-verified IBAN on the dashboard only: no delivery, no email", async () => {
    const { smtp, errors, run, listing } = setup();
    listing({ description: "<p>Payment only by bank transfer to DE89 3704 0044 0532 0130 00 please.</p>" });

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    expect(await run("send")).toBe(0);

    expect(errors).toEqual([]);
    expect(await rows("SELECT final_verdict, blocked_by_code FROM app.alert")).toEqual([{ final_verdict: "block", blocked_by_code: true }]);
    expect(await rows("SELECT id FROM app.alert_delivery")).toEqual([]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "blocked" }]);
    expect(await rows("SELECT code_signals FROM app.screening")).toEqual([{ code_signals: ["iban_present"] }]);
    expect(smtp.sent).toEqual([]);
  });

  it("flags contact data with a contact phrase from the raw description as a caution, and emails CHECK", async () => {
    const { smtp, errors, run, listing } = setup();
    listing({ description: "<p>Schreib mir per WhatsApp 0151 2345678 für Fragen.</p>" });

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    await run("send");

    expect(errors).toEqual([]);
    expect(await rows("SELECT code_signals FROM app.screening")).toEqual([{ code_signals: ["off_ebay_contact_phrase"] }]);
    expect(await rows("SELECT final_verdict, blocked_by_code FROM app.alert")).toEqual([{ final_verdict: "caution", blocked_by_code: false }]);
    expect(smtp.sent.map((m) => m.subject)).toEqual([expect.stringMatching(/ - CHECK$/)]);
  });
});

describe("heartbeat (section 2.6)", () => {
  it("after SELECT 1 and a started queue touches the alive file and writes heartbeat_at", async () => {
    const file = join(tmpdir(), `worker-alive-${randomUUID()}`);
    const clock = createTestClock(NOW);
    const log = createTestLog();
    await upsertWorkerStatus(db.pool, { gitSha: ENV.GIT_SHA, startedAt: NOW, smtpConfigured: true, claudeConfigured: true });
    clock.advance(10_000);
    const before = Date.now();

    const heartbeat = createHeartbeat({ pool: db.pool, queue: { isStarted: () => true }, clock, file, log: log.log });
    await heartbeat.beat();

    expect((await stat(file)).mtimeMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(await rows("SELECT heartbeat_at FROM app.worker_status")).toEqual([{ heartbeat_at: new Date(NOW.getTime() + 10_000) }]);
    await rm(file);
  });

  it("touches nothing while pg-boss is stopped or the database does not answer, and logs why", async () => {
    const file = join(tmpdir(), `worker-alive-${randomUUID()}`);
    const clock = createTestClock(NOW);
    const log = createTestLog();
    await upsertWorkerStatus(db.pool, { gitSha: ENV.GIT_SHA, startedAt: NOW, smtpConfigured: true, claudeConfigured: true });
    clock.advance(10_000);
    const deadDatabase = {
      query: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED postgres://worker:secret@postgres"), { code: "ECONNREFUSED" });
      },
    };

    await createHeartbeat({ pool: db.pool, queue: { isStarted: () => false }, clock, file, log: log.log }).beat();
    await createHeartbeat({ pool: deadDatabase, queue: { isStarted: () => true }, clock, file, log: log.log }).beat();

    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await rows("SELECT heartbeat_at FROM app.worker_status")).toEqual([{ heartbeat_at: NOW }]);
    expect(log.events("heartbeat_skipped"), "a skipped beat logs heartbeat_skipped with the reason queue_stopped or database").toEqual([
      { event: "heartbeat_skipped", reason: "queue_stopped" },
      { event: "heartbeat_skipped", reason: "database", err_code: "ECONNREFUSED" },
    ]);
    expect(log.text()).not.toContain("secret");
  });

  it("beats at once on start and then every interval, never two at a time, and not after stop", async () => {
    const file = join(tmpdir(), `worker-alive-${randomUUID()}`);
    const statements: string[] = [];
    let running = 0;
    let overlap = false;
    const slowDatabase = {
      query: async (...args: unknown[]) => {
        running += 1;
        overlap ||= running > 1;
        statements.push(String(args[0]));
        await new Promise((resolve) => setTimeout(resolve, 30));
        running -= 1;
        return { rows: [], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
      },
    };
    const heartbeat = createHeartbeat({
      pool: slowDatabase,
      queue: { isStarted: () => true },
      clock: createTestClock(NOW),
      file,
      log: createTestLog().log,
      intervalMs: 20,
    });

    heartbeat.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await heartbeat.stop();
    const beats = statements.filter((s) => s === "SELECT 1").length;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(beats).toBeGreaterThanOrEqual(2);
    expect(statements.filter((s) => s === "SELECT 1")).toHaveLength(beats);
    expect(overlap).toBe(false);
    await rm(file, { force: true });
  });
});

describe("worker start (section 2.6)", () => {
  it("starts pg-boss with the schedules and every handler, writes worker_status, beats, and stops on shutdown", async () => {
    // No feed is due, so the schedules running during the test call no fake.
    await db.admin.query("UPDATE app.feed SET enabled = false");
    const aliveFile = join(tmpdir(), `worker-alive-${randomUUID()}`);
    const log = createTestLog();
    const exit = vi.fn();

    const worker = await startWorker(parseEnv({ ...ENV, DATABASE_URL: db.workerUrl }), {
      clock: { now: () => new Date() },
      log: log.log,
      ebayFetch: createFakeEbay().fetchFn,
      claudeFetch: createFakeClaude().fetchFn,
      createTransport: createFakeSmtp().createTransport,
      aliveFile,
    });
    try {
      expect(await rows("SELECT git_sha, smtp_configured, claude_configured FROM app.worker_status")).toEqual([
        { git_sha: ENV.GIT_SHA, smtp_configured: true, claude_configured: true },
      ]);
      expect(await rows("SELECT name, cron FROM pgboss.schedule ORDER BY name")).toEqual([
        { name: "poll-tick", cron: "* * * * *" },
        { name: "purge", cron: "*/15 * * * *" },
        { name: "relay", cron: "* * * * *" },
      ]);
      // A purge job is taken by the registered handler, which writes its run row.
      await worker.queue.send("purge", {});
      const purgeRuns = async () => expect(await rows("SELECT status FROM app.purge_run"), "the handler registered for purge works the job").toEqual([{ status: "ok" }]);
      await vi.waitFor(purgeRuns, {
        timeout: 20_000,
        interval: 200,
      });
      const touched = async () =>
        expect(await stat(aliveFile).then(() => true, () => false), "the heartbeat started by startWorker touches the alive file").toBe(true);
      await vi.waitFor(touched, { timeout: 5_000 });
    } finally {
      await createShutdown({
        heartbeat: worker.heartbeat,
        queue: worker.queue,
        endPool: () => worker.pool.end(),
        log: { ...log.log, flush: () => undefined },
        exit,
        timing: SHUTDOWN_TIMING,
      })("SIGTERM");
      await rm(aliveFile, { force: true });
    }

    expect(exit.mock.calls).toEqual([[0]]);
    expect(worker.queue.isStarted()).toBe(false);
  });

  it("logs a lost pool connection by its code only and keeps running", async () => {
    await db.admin.query("UPDATE app.feed SET enabled = false");
    const aliveFile = join(tmpdir(), `worker-alive-${randomUUID()}`);
    const log = createTestLog();
    const worker = await startWorker(parseEnv({ ...ENV, DATABASE_URL: db.workerUrl }), {
      clock: { now: () => new Date() },
      log: log.log,
      ebayFetch: createFakeEbay().fetchFn,
      claudeFetch: createFakeClaude().fetchFn,
      aliveFile,
    });
    try {
      worker.pool.emit("error", Object.assign(new Error("terminating connection postgres://worker:secret@postgres"), { code: "57P01" }));

      expect(log.events("database_pool_error")).toEqual([{ event: "database_pool_error", err_code: "57P01" }]);
      expect(log.text()).not.toContain("secret");
      expect(worker.queue.isStarted()).toBe(true);
    } finally {
      await worker.heartbeat.stop();
      await worker.queue.stop({ graceful: false, timeoutMs: 5_000 });
      await worker.pool.end();
      await rm(aliveFile, { force: true });
    }
  });

  it("refuses to start on a database without the pg-boss schema (A12)", async () => {
    const empty = `worker_test_empty_${randomUUID().replaceAll("-", "")}`;
    await db.admin.query(`CREATE DATABASE ${empty}`);
    const url = new URL(db.workerUrl);
    url.pathname = `/${empty}`;
    url.searchParams.delete("options");
    try {
      await expect(
        startWorker(parseEnv({ ...ENV, DATABASE_URL: url.toString() }), {
          clock: { now: () => new Date() },
          log: createTestLog().log,
          ebayFetch: createFakeEbay().fetchFn,
          claudeFetch: createFakeClaude().fetchFn,
          aliveFile: join(tmpdir(), `worker-alive-${randomUUID()}`),
        }),
      ).rejects.toThrow();
    } finally {
      await db.admin.query(`DROP DATABASE ${empty} WITH (FORCE)`);
    }
  });

  it("works a job of every queue in the registry", async () => {
    // Feeds paused and unknown ids: every job runs its handler and changes nothing.
    await db.admin.query("UPDATE app.feed SET enabled = false");
    const aliveFile = join(tmpdir(), `worker-alive-${randomUUID()}`);
    const log = createTestLog();
    const worker = await startWorker(parseEnv({ ...ENV, DATABASE_URL: db.workerUrl }), {
      clock: { now: () => new Date() },
      log: log.log,
      ebayFetch: createFakeEbay().fetchFn,
      claudeFetch: createFakeClaude().fetchFn,
      createTransport: createFakeSmtp().createTransport,
      aliveFile,
    });
    try {
      const payloads: { [N in QueueName]: QueuePayloads[N] } = {
        "poll-tick": {},
        poll: { feedId: "gpu" },
        sweep: { segment: "gpu_3090" },
        enrich: { listingId: randomUUID() },
        screen: { listingId: randomUUID() },
        send: { deliveryId: randomUUID() },
        relay: {},
        purge: {},
      };
      // A cron job of an exclusive queue (poll-tick, relay, purge) can already be queued when the
      // test sends, which then returns null; that job counts the same.
      await Promise.all(QUEUE_NAMES.map((name) => worker.queue.send(name, payloads[name] as never)));
      const states = async () =>
        expect(
          await rows("SELECT DISTINCT name FROM pgboss.job WHERE state = 'completed' AND name = ANY($1::text[]) ORDER BY name", [
            [...QUEUE_NAMES],
          ]),
          "every queue has a registered handler that completes its job",
        ).toEqual([...QUEUE_NAMES].sort().map((name) => ({ name })));
      await vi.waitFor(states, { timeout: 30_000, interval: 250 });
    } finally {
      await worker.heartbeat.stop();
      await worker.queue.stop({ graceful: false, timeoutMs: 5_000 });
      await worker.pool.end();
      await rm(aliveFile, { force: true });
    }
  });
});

describe("shutdown (section 2.6)", () => {
  it("on SIGTERM stops the heartbeat, stops pg-boss gracefully within 60 s, ends the pool, flushes the log and exits 0; a second signal does nothing", async () => {
    const events: string[] = [];
    const exit = vi.fn((code: number) => events.push(`exit ${code}`));
    const shutdown = createShutdown({
      heartbeat: { stop: async () => void events.push("heartbeat.stop") },
      queue: { stop: async (options) => void events.push(`queue.stop ${JSON.stringify(options)}`) },
      endPool: async () => void events.push("endPool"),
      log: {
        info: (entry) => events.push(`log ${String(entry.event)}`),
        error: (entry) => events.push(`error ${String(entry.event)}`),
        flush: () => events.push("log.flush"),
      },
      exit,
      timing: SHUTDOWN_TIMING,
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(events).toEqual([
      "log shutdown",
      "heartbeat.stop",
      'queue.stop {"graceful":true,"timeoutMs":60000}',
      "endPool",
      "log shutdown_done",
      "log.flush",
      "exit 0",
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits 1 at the hard stop when pg-boss does not stop in time, with the log flushed", async () => {
    const events: string[] = [];
    const exited = new Promise<number>((resolve) => {
      const shutdown = createShutdown({
        heartbeat: { stop: async () => undefined },
        // A handler that never finishes keeps pg-boss from stopping.
        queue: { stop: () => new Promise<never>(() => undefined) },
        endPool: async () => void events.push("endPool"),
        log: {
          info: (entry) => events.push(`log ${String(entry.event)}`),
          error: (entry) => events.push(`error ${String(entry.event)}`),
          flush: () => events.push("log.flush"),
        },
        exit: resolve,
        timing: { queueStopMs: 50, hardStopMs: 100 },
      });
      void shutdown("SIGTERM");
    });

    expect(await exited).toBe(1);
    expect(events).toEqual(["log shutdown", "error shutdown_timeout", "log.flush"]);
  });

  it("never fires the hard stop after a clean exit", async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({
      heartbeat: { stop: async () => undefined },
      queue: { stop: async () => undefined },
      endPool: async () => undefined,
      log: { info: () => undefined, error: () => undefined, flush: () => undefined },
      exit,
      timing: { queueStopMs: 50, hardStopMs: 100 },
    });

    await shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("exits 1 at once when a step fails, logging the error name and never its message", async () => {
    const lines: Record<string, unknown>[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      heartbeat: { stop: async () => undefined },
      queue: { stop: async () => undefined },
      endPool: async () => {
        throw new Error("Connection terminated: postgres://worker:secret@postgres");
      },
      log: { info: () => undefined, error: (entry) => lines.push(entry), flush: () => undefined },
      exit,
      timing: SHUTDOWN_TIMING,
    });

    await shutdown("SIGTERM");

    expect(exit.mock.calls).toEqual([[1]]);
    expect(lines).toEqual([{ event: "shutdown_failed", signal: "SIGTERM", err_name: "Error" }]);
  });
});

describe("command line (sections 2.6, 6.5)", () => {
  function processFake(argv: string[], env: Record<string, string | undefined> = ENV) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = vi.fn();
    const signals = new Map<string, () => void>();
    const log = createTestLog();
    const flushes: string[] = [];
    const aliveFile = join(tmpdir(), `worker-alive-${randomUUID()}`);
    return {
      stdout,
      stderr,
      exit,
      signals,
      log,
      flushes,
      aliveFile,
      deps: {
        argv,
        loadEnv: () => parseEnv(env),
        clock: createTestClock(NOW),
        stdout: (line: string) => void stdout.push(line),
        stderr: (line: string) => void stderr.push(line),
        exit,
        fetchFn: createFakeEbay().fetchFn,
        createTransport: createFakeSmtp().createTransport,
        createLog: (level: string) => ({ ...log.log, flush: () => void flushes.push(level) }),
        onSignal: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void signals.set(signal, handler),
        aliveFile,
      },
    };
  }

  it("with no command starts the worker, and SIGTERM shuts it down with exit 0", async () => {
    // No feed is due, so the schedules running during the test call no fake.
    await db.admin.query("UPDATE app.feed SET enabled = false");
    const fake = processFake([], { ...ENV, DATABASE_URL: db.workerUrl, LOG_LEVEL: "warn" });

    await runMain(fake.deps);
    try {
      expect(fake.exit).not.toHaveBeenCalled();
      expect([...fake.signals.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
      expect(await rows("SELECT git_sha, started_at FROM app.worker_status")).toEqual([{ git_sha: ENV.GIT_SHA, started_at: NOW }]);
      expect(fake.log.events("worker_started")).toEqual([
        { event: "worker_started", git_sha: ENV.GIT_SHA, smtp_configured: true, claude_configured: true },
      ]);
      await vi.waitFor(async () => expect(await stat(fake.aliveFile).then(() => true, () => false)).toBe(true), { timeout: 5_000 });

      fake.signals.get("SIGTERM")?.();
      await vi.waitFor(() => expect(fake.exit.mock.calls).toEqual([[0]]), { timeout: 30_000, interval: 100 });
      expect(fake.log.events("shutdown_done")).toEqual([{ event: "shutdown_done", signal: "SIGTERM" }]);
      expect(fake.flushes, "the logger is made at LOG_LEVEL and flushed on shutdown").toEqual(["warn"]);
    } finally {
      await rm(fake.aliveFile, { force: true });
    }
  });

  it("exits 1 when the worker cannot start, logging the error name and never the database URL", async () => {
    const empty = `worker_test_empty_${randomUUID().replaceAll("-", "")}`;
    await db.admin.query(`CREATE DATABASE ${empty}`);
    const url = new URL(db.workerUrl);
    url.pathname = `/${empty}`;
    url.searchParams.delete("options");
    const fake = processFake([], { ...ENV, DATABASE_URL: url.toString() });
    try {
      await runMain(fake.deps);
    } finally {
      await db.admin.query(`DROP DATABASE ${empty} WITH (FORCE)`);
    }

    expect(fake.exit.mock.calls).toEqual([[1]]);
    expect(fake.signals.size).toBe(0);
    expect(fake.log.events("worker_start_failed")).toMatchObject([{ event: "worker_start_failed" }]);
    expect(fake.log.text()).not.toContain(url.password);
    expect(fake.flushes).toHaveLength(1);
  });

  it("refuses an unknown command with the usage and exit code 2", async () => {
    const fake = processFake(["mail:tset"]);

    await runMain(fake.deps);

    expect(fake.exit.mock.calls).toEqual([[2]]);
    expect(fake.stderr).toEqual(["usage: node dist/main.js [mail:test]"]);
  });

  it("exits 1 on an invalid environment, printing the variable names only", async () => {
    const fake = processFake([], { ...ENV, SMTP_HOST: "" });

    await runMain(fake.deps);

    expect(fake.exit.mock.calls).toEqual([[1]]);
    expect(fake.stderr).toEqual(["invalid environment: SMTP is set partially, missing SMTP_HOST"]);
    expect(fake.stderr.join("\n")).not.toContain(SMTP_TEST_PASSWORD);
  });

  it("runs mail:test without the database and exits with its result", async () => {
    const smtp = createFakeSmtp();
    const fake = processFake(["mail:test"], { ...ENV, DATABASE_URL: "postgres://worker:unused@127.0.0.1:1/none" });

    await runMain({ ...fake.deps, createTransport: smtp.createTransport });

    expect(fake.exit.mock.calls).toEqual([[0]]);
    expect(fake.stdout).toEqual(["mail:test: sent, SMTP 250, message ID <fake-1@smtp.test>"]);
    expect(smtp.sent).toHaveLength(1);
  });
});

describe("mail:test (section 6.5)", () => {
  it("sends one fixed message without eBay content to ALERT_TO and prints the SMTP reply code and message ID", async () => {
    const smtp = createFakeSmtp();
    const lines: string[] = [];

    const exitCode = await runMailTest({
      env: parseEnv(ENV),
      createTransport: smtp.createTransport,
      clock: createTestClock(NOW),
      out: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["mail:test: sent, SMTP 250, message ID <fake-1@smtp.test>"]);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({
      from: { name: "Just-Buy-It", address: "alerts@example.test" },
      to: ALERT_TO,
      subject: "just-buy-it SMTP test",
    });
    expect(String(smtp.sent[0]?.text)).not.toContain("ebay.de");
  });

  it("exits 1 naming the missing settings when SMTP is not configured", async () => {
    const smtp = createFakeSmtp();
    const lines: string[] = [];

    const exitCode = await runMailTest({
      env: parseEnv({ ...ENV, ...SMTP_UNSET }),
      createTransport: smtp.createTransport,
      clock: createTestClock(NOW),
      out: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(lines).toEqual(["mail:test: SMTP is not configured (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERT_FROM)"]);
    expect(smtp.transportOptions).toEqual([]);
  });
});


describe("flow: SMTP and the relay retry path (sections 2.4, 6.4, 6.5)", () => {
  it("holds the delivery while SMTP is unset, and once SMTP is set and the worker rewired, relay sends it once", async () => {
    const { clock, smtp, errors, run, tick, listing, rewire } = setup(SMTP_UNSET);
    listing();

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    await run("send");

    expect(errors).toEqual([]);
    expect(smtp.sent).toEqual([]);
    expect(await rows("SELECT status, hold_reason, attempt FROM app.alert_delivery")).toEqual([
      { status: "pending", hold_reason: "smtp_not_configured", attempt: 0 },
    ]);

    // The owner sets the SMTP values and restarts the worker.
    rewire({});
    clock.advance(5 * 60_000);
    await tick("relay");
    expect(await run("send"), "the wired relay handler queues the due delivery").toBe(1);
    await tick("relay");
    expect(await run("send")).toBe(0);

    expect(errors).toEqual([]);
    expect(smtp.sent).toHaveLength(1);
    expect(await rows("SELECT status, hold_reason, attempt FROM app.alert_delivery")).toEqual([
      { status: "sent", hold_reason: null, attempt: 1 },
    ]);
  });

  it("after a 421 sets next_attempt_at by the backoff, and relay retries once it is due", async () => {
    const { clock, smtp, errors, run, tick, listing } = setup();
    listing();
    smtp.reply(421);

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    await run("send");

    expect(await rows("SELECT status, attempt, last_error_code, next_attempt_at FROM app.alert_delivery")).toEqual([
      { status: "pending", attempt: 1, last_error_code: "EENVELOPE", next_attempt_at: new Date(NOW.getTime() + 60_000) },
    ]);
    // Not due yet: relay queues nothing.
    clock.advance(30_000);
    await tick("relay");
    expect(await run("send")).toBe(0);
    clock.advance(30_000);
    await tick("relay");
    expect(await run("send")).toBe(1);

    expect(errors).toEqual([]);
    expect(smtp.sent).toHaveLength(2);
    expect(await rows("SELECT status, attempt FROM app.alert_delivery")).toEqual([{ status: "sent", attempt: 2 }]);
  });

  it("holds the 11th email of the hour for the rate limit with attempt unchanged", async () => {
    const { ebay, smtp, errors, run } = setup();
    const created = new Date(NOW.getTime() - HOUR_MS).toISOString();
    const legacyItemIds = Array.from({ length: 11 }, () => fakeLegacyItemId());
    ebay.searchPages(
      searchPage(legacyItemIds.map((legacyItemId) => gpuSummary({ legacyItemId, price: "450.00", shipping: "10.00", itemCreationDate: created }))),
    );
    for (const legacyItemId of legacyItemIds) ebay.item(`v1|${legacyItemId}|0`, itemBody(legacyItemId, {}));

    await queue.send("poll", { feedId: "gpu" });
    await run("poll");
    await run("enrich");
    await run("screen");
    expect(await run("send")).toBe(11);

    expect(errors).toEqual([]);
    expect(smtp.sent).toHaveLength(10);
    expect(await rows("SELECT status, hold_reason, attempt, count(*)::int AS n FROM app.alert_delivery GROUP BY 1, 2, 3 ORDER BY 1")).toEqual([
      { status: "pending", hold_reason: "rate_limit", attempt: 0, n: 1 },
      { status: "sent", hold_reason: null, attempt: 1, n: 10 },
    ]);
  });
});
