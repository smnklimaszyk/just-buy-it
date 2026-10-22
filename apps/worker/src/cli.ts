import { randomUUID } from "node:crypto";
import type { Clock } from "@ebay-sniper/domain";
import type { FetchFn } from "@ebay-sniper/ebay";
import { createSmtpMailer, SmtpError, type CreateTransportFn, type SmtpSendResult } from "@ebay-sniper/notify";
import { EnvError, type WorkerEnv } from "./env.js";
import type { LogFn } from "./handlers/poll.js";
import { createShutdown, SHUTDOWN_TIMING } from "./shutdown.js";
import { startWorker, type Worker } from "./wiring.js";

export type WorkerLog = { info: LogFn; warn: LogFn; error: LogFn; flush: () => void };

export type MainDeps = {
  argv: string[];
  loadEnv: () => WorkerEnv;
  clock: Clock;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  exit: (code: number) => void;
  // eBay and Claude calls.
  fetchFn: FetchFn;
  // Omitted: nodemailer.
  createTransport?: CreateTransportFn;
  // The logger at LOG_LEVEL, made once the environment is read.
  createLog: (level: string) => WorkerLog;
  onSignal: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
  // The file the heartbeat touches for the Compose healthcheck.
  aliveFile: string;
};

const USAGE = "usage: node dist/main.js [mail:test]";

// main.ts with the process passed in: `node dist/main.js` runs the worker, `node dist/main.js
// mail:test` sends one test email (section 6.5).
export async function runMain(deps: MainDeps): Promise<void> {
  let env: WorkerEnv;
  try {
    env = deps.loadEnv();
  } catch (error) {
    // The message names the failing variables only, never a value.
    if (!(error instanceof EnvError)) throw error;
    deps.stderr(error.message);
    deps.exit(1);
    return;
  }
  const [command, ...args] = deps.argv;
  if (command === undefined) {
    await runWorker(env, deps);
    return;
  }
  if (command === "mail:test" && args.length === 0) {
    // No database and no eBay: Compose runs it with --no-deps.
    deps.exit(await runMailTest({ env, clock: deps.clock, out: deps.stdout, ...(deps.createTransport ? { createTransport: deps.createTransport } : {}) }));
    return;
  }
  deps.stderr(USAGE);
  deps.exit(2);
}

// Section 2.6. Returns once the worker runs; pg-boss keeps the process alive until a signal.
async function runWorker(env: WorkerEnv, deps: MainDeps): Promise<void> {
  const log = deps.createLog(env.logLevel);
  let worker: Worker;
  try {
    worker = await startWorker(env, {
      clock: deps.clock,
      log,
      ebayFetch: deps.fetchFn,
      claudeFetch: deps.fetchFn,
      ...(deps.createTransport ? { createTransport: deps.createTransport } : {}),
      aliveFile: deps.aliveFile,
    });
  } catch (error) {
    // A missing or different pg-boss schema ends here (A12), and Compose shows the worker
    // unhealthy. The name and code only: a connection error message can carry the database URL.
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
    log.error({ event: "worker_start_failed", err_name: error instanceof Error ? error.name : "unknown", err_code: code });
    log.flush();
    deps.exit(1);
    return;
  }
  log.info({
    event: "worker_started",
    git_sha: env.gitSha,
    smtp_configured: env.smtp !== null,
    claude_configured: env.claude.apiKey !== null,
  });
  const shutdown = createShutdown({
    heartbeat: worker.heartbeat,
    queue: worker.queue,
    endPool: () => worker.pool.end(),
    log,
    exit: deps.exit,
    timing: SHUTDOWN_TIMING,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) deps.onSignal(signal, () => void shutdown(signal));
}

export type MailTestDeps = {
  env: WorkerEnv;
  // Omitted: nodemailer.
  createTransport?: CreateTransportFn;
  clock: Clock;
  out: (line: string) => void;
};

// `node dist/main.js mail:test` (section 6.5): one fixed message with no eBay content to ALERT_TO,
// over the same SMTP adapter the send job uses. It prints the reply code and the message ID.
export async function runMailTest(deps: MailTestDeps): Promise<number> {
  const { env } = deps;
  if (env.smtp === null) {
    deps.out("mail:test: SMTP is not configured (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERT_FROM)");
    return 1;
  }
  const mailer = createSmtpMailer(env.smtp, deps.createTransport);
  const sentAt = deps.clock.now().toISOString();
  let result: SmtpSendResult;
  try {
    result = await mailer.send({
      deliveryId: randomUUID(),
      to: env.alertTo,
      subject: "just-buy-it SMTP test",
      text: `This is a test message from the just-buy-it worker (mail:test), sent at ${sentAt}. It carries no listing.`,
      html: `<p>This is a test message from the just-buy-it worker (mail:test), sent at ${sentAt}. It carries no listing.</p>`,
    });
  } catch (error) {
    // The adapter's error has the code and reply code only, never the AUTH exchange.
    if (!(error instanceof SmtpError)) throw error;
    deps.out(`mail:test: failed, ${error.code}, SMTP ${error.responseCode ?? "no reply"}`);
    return 1;
  }
  deps.out(`mail:test: sent, SMTP ${result.responseCode ?? "unknown"}, message ID ${result.messageId}`);
  return 0;
}
