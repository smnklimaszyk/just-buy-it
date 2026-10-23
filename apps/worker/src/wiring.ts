import { createPool, reserveEbayCall, upsertWorkerStatus, type DbPool } from "@ebay-sniper/db";
import { QUEUE_NAMES, startQueue, WORKER_POOL_MAX, type JobHandler, type JobQueue, type QueueName } from "@ebay-sniper/db/queue";
import type { Clock } from "@ebay-sniper/domain";
import { createAppTokenCache, createBrowseClient, createItemClient, type FetchFn, type ReserveEbayCall } from "@ebay-sniper/ebay";
import { createClaudeScreener, type ClaudeScreener } from "@ebay-sniper/llm";
import { createSmtpMailer, type CreateTransportFn, type SmtpMailer } from "@ebay-sniper/notify";
import type { WorkerEnv } from "./env.js";
import { createCategorySuggestHandler } from "./handlers/category-suggest.js";
import { createEnrichHandler } from "./handlers/enrich.js";
import { createHeldRequeueHandler } from "./handlers/held-requeue.js";
import { createMarketNightlyHandler } from "./handlers/market-nightly.js";
import { createMarketSnapshotHandler } from "./handlers/market-snapshot.js";
import { createPollTickHandler } from "./handlers/poll-tick.js";
import { createPollHandler, type LogFn, type SearchDeps } from "./handlers/poll.js";
import { createPurgeHandler } from "./handlers/purge.js";
import { createRelayHandler } from "./handlers/relay.js";
import { createScreenHandler } from "./handlers/screen.js";
import { createSendHandler } from "./handlers/send.js";
import { createSweepHandler } from "./handlers/sweep.js";
import { createHeartbeat, type Heartbeat } from "./heartbeat.js";
import { createItemKey } from "./item-key.js";
import { createRequestQueuer } from "./market/requests.js";

export type WorkerIo = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  log: { info: LogFn; warn: LogFn; error: LogFn };
  ebayFetch: FetchFn;
  claudeFetch: FetchFn;
  createTransport?: CreateTransportFn;
  reserve: ReserveEbayCall;
};

export type Handlers = { [N in QueueName]: JobHandler<N> };

export type Wiring = {
  handlers: Handlers;
  // null while ANTHROPIC_API_KEY is unset.
  screener: ClaudeScreener | null;
  // null while SMTP is not configured.
  mailer: SmtpMailer | null;
};

export function createWiring(env: WorkerEnv, io: WorkerIo): Wiring {
  const { pool, queue, clock, log } = io;
  // One eBay token cache for every Browse call.
  const token = createAppTokenCache({
    apiBase: env.ebayApiBase,
    clientId: env.ebayClientId,
    clientSecret: env.ebayClientSecret,
    fetchFn: io.ebayFetch,
    clock,
  });
  const browse = (reserve: ReserveEbayCall) => ({
    apiBase: env.ebayApiBase,
    marketplaceId: "EBAY_DE" as const,
    token,
    fetchFn: io.ebayFetch,
    reserve,
  });
  // Enrich calls getItem only with a Claude slot (section 2.4), so it needs the Claude adapter and
  // both caps; the alert it makes without a slot needs the recipient and the buyer profile.
  const screener = env.claude.apiKey === null ? null : createClaudeScreener({ apiKey: env.claude.apiKey, fetchFn: io.claudeFetch });
  const claude = { screener, callLimit: env.claude.callLimit, spendLimitMicrousd: env.claude.spendLimitMicrousd };
  const alerts = { recipient: env.alertTo, buyerProfile: env.buyerProfile };
  const createSearch = (reserve: ReserveEbayCall) => createBrowseClient(browse(reserve)).searchItems;
  const itemKey = createItemKey(env.itemKeySecret);
  const { settingsEnv } = env;
  // Polls and sweeps search the same way.
  const search: SearchDeps = {
    pool,
    queue,
    clock,
    reserve: io.reserve,
    createSearch,
    itemKey,
    postalCode: env.postalCode,
    settingsEnv,
    log,
  };
  // null while SMTP is not configured (env.smtp null); the send handler then holds every delivery.
  const mailer = env.smtp && createSmtpMailer(env.smtp, io.createTransport);
  return {
    screener,
    mailer,
    handlers: {
      "poll-tick": createPollTickHandler({ pool, queue, clock, settingsEnv, queueRequests: createRequestQueuer({ pool, queue }), log }),
      poll: createPollHandler(search),
      sweep: createSweepHandler(search),
      enrich: createEnrichHandler({
        pool,
        queue,
        clock,
        getItem: createItemClient(browse(io.reserve)).getItem,
        postalCode: env.postalCode,
        claude,
        settingsEnv,
        alerts,
        log,
      }),
      screen: createScreenHandler({ pool, queue, clock, claude, settingsEnv, alerts, log }),
      send: createSendHandler({ pool, clock, mailer, log }),
      relay: createRelayHandler({ pool, queue, clock, log }),
      purge: createPurgeHandler({ pool, clock, log }),
      "market-nightly": createMarketNightlyHandler({ pool, queue, log }),
      "market-snapshot": createMarketSnapshotHandler({ pool, clock, reserve: io.reserve, createSearch, itemKey, postalCode: env.postalCode, log }),
      "category-suggest": createCategorySuggestHandler({ pool, clock, reserve: io.reserve, createSearch, log }),
      "held-requeue": createHeldRequeueHandler({ pool, queue, clock, log }),
    },
  };
}

export type WorkerStartIo = Omit<WorkerIo, "pool" | "queue" | "reserve"> & {
  // The file the heartbeat touches for the Compose healthcheck.
  aliveFile: string;
};

export type Worker = { pool: DbPool; queue: JobQueue; heartbeat: Heartbeat; wiring: Wiring };

// Section 2.6, in order: the pool, pg-boss, the worker_status row.
export async function startWorker(env: WorkerEnv, io: WorkerStartIo): Promise<Worker> {
  const { clock, log } = io;
  // The code only: a connection error message can carry the database URL.
  const logError = (event: string) => (error: Error) =>
    log.warn({ event, err_code: "code" in error && typeof error.code === "string" ? error.code : error.name });
  const pool = createPool({
    connectionString: env.databaseUrl,
    max: WORKER_POOL_MAX,
    applicationName: "ebay-sniper-worker",
    statementTimeoutMs: env.statementTimeoutMs,
    onError: logError("database_pool_error"),
  });
  let queue: JobQueue;
  try {
    queue = await startQueue({ connectionString: env.databaseUrl, onError: logError("queue_error") });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const wiring = createWiring(env, {
    ...io,
    pool,
    queue,
    // ADR 0008: reserve_ebay_call gets p_now from the injected clock.
    reserve: (reservation) => reserveEbayCall(pool, { ...reservation, now: clock.now() }),
  });
  // The cron schedules of the registry, in UTC.
  await queue.schedule();
  // Every queue of the registry gets its handler.
  for (const name of QUEUE_NAMES) await queue.work(name, wiring.handlers[name] as JobHandler<typeof name>);
  await upsertWorkerStatus(pool, {
    gitSha: env.gitSha,
    startedAt: clock.now(),
    smtpConfigured: env.smtp !== null,
    claudeConfigured: env.claude.apiKey !== null,
  });
  const heartbeat = createHeartbeat({ pool, queue, clock, file: io.aliveFile, log });
  heartbeat.start();
  return { pool, queue, heartbeat, wiring };
}
