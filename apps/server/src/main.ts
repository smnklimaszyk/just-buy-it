import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { addHourlyCounts, createPool, recordDeletionEvent, recordProbeSeen } from "@ebay-sniper/db";
import { createLogger, loggerOptions } from "@ebay-sniper/logging";
import { createApp, type IncomingNotification } from "./app.js";
import { systemClock } from "./clock.js";
import { createDeletionCounters } from "./deletion-counters.js";
import { createDeletionQueue } from "./deletion-queue.js";
import { createKeyLookup } from "./ebay-wiring.js";
import { loadEnv } from "./env.js";
import { createNotificationWork } from "./notifications.js";
import { createProbeRecorder } from "./probe.js";
import { createShutdown, SHUTDOWN_TIMING } from "./shutdown.js";

const logger = createLogger(loggerOptions("info"));
const log = {
  info: (entry: Record<string, unknown>) => logger.info(entry),
  warn: (entry: Record<string, unknown>) => logger.warn(entry),
  error: (entry: Record<string, unknown>) => logger.error(entry),
};
const env = loadEnv();

// Three connections as role app (spec S3, section 2.4). The listener keeps an idle client that
// loses its connection from ending the process; the message is not logged, only the code.
const pool = createPool({
  connectionString: env.databaseUrl,
  max: 3,
  applicationName: "ebay-sniper-server",
  onError: (error) =>
    log.warn({ event: "database_pool_error", err_code: "code" in error ? String(error.code) : error.name }),
});

const counters = createDeletionCounters({
  clock: systemClock,
  store: (counts) => addHourlyCounts(pool, counts),
  log,
});

const { ebayClientId, ebayClientSecret } = env;
const credentials =
  ebayClientId && ebayClientSecret ? { clientId: ebayClientId, clientSecret: ebayClientSecret } : undefined;
const lookupKey = createKeyLookup({
  apiBase: env.ebayApiBase,
  credentials,
  fetchFn: fetch,
  clock: systemClock,
  countRequest: counters.countRequest,
});

const queue = createDeletionQueue<IncomingNotification>({
  capacity: 1_000,
  concurrency: 4,
  work: createNotificationWork({
    lookupKey,
    countResult: counters.countResult,
    recordVerified: (event) => recordDeletionEvent(pool, event),
    log,
    clock: systemClock,
  }),
  onDropped: counters.countResult,
  onError: () => log.error({ event: "ebay_account_deletion", msg: "notification processing failed" }),
});

const probe = createProbeRecorder({
  clock: systemClock,
  record: (seenAt) => recordProbeSeen(pool, seenAt),
  log,
});

const app = createApp({
  endpointUrl: env.deletionEndpointUrl,
  verificationToken: env.deletionVerificationToken,
  gitSha: env.gitSha,
  probeCode: env.deletionProbeCode,
  onProbe: probe.seen,
  onNotification: queue.push,
});

const server = createServer(getRequestListener(app.fetch));
server.listen(env.port, "0.0.0.0", () =>
  logger.info({ port: env.port, credentials: credentials !== undefined }, "server listening"),
);
counters.start();

const shutdown = createShutdown({
  server,
  queue,
  counters,
  endPool: () => pool.end(),
  log: { ...log, flush: () => logger.flush() },
  now: () => performance.now(),
  exit: (code) => process.exit(code),
  timing: SHUTDOWN_TIMING,
});

// process.on, not once: a second signal must reach the handler, which ignores it, instead of
// Node's default, which would end the process at once.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown(signal));
