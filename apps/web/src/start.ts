import { RoleCheckError, type DbPool } from "@ebay-sniper/db";
import type { Clock } from "@ebay-sniper/domain";
import { PROMPT_VERSION, SCREENING_EVALS, worstCaseCostMicrousd, type ScreeningEval } from "@ebay-sniper/llm/catalog";
import type { SmtpConfig, SmtpMailer } from "@ebay-sniper/notify";
import { createApp, type AppDeps } from "./app.js";
import { createAuthKeys } from "./auth/keys.js";
import { createOutbox } from "./auth/security-mail.js";
import { createSecurityWatch } from "./auth/security-watch.js";
import { createBackground, type Log } from "./background.js";
import type { WebEnv } from "./env.js";
import type { ScreeningOption } from "./pages/settings/options.js";
import type { AssetManifest } from "./ui/assets.js";

// What the web process needs from the outside; main.ts passes the real ones.
export type WebRuntime = {
  env: WebEnv;
  clock: Clock;
  log: Log & { flush(): void };
  checkRole(databaseUrl: string): Promise<void>;
  createPool(databaseUrl: string): DbPool;
  readManifest(): Promise<AssetManifest>;
  assetFile(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  createMailer(config: SmtpConfig): SmtpMailer;
  listen(fetch: (request: Request) => Response | Promise<Response>, port: number): { close(): Promise<void> };
  every(ms: number, task: () => Promise<void>): { stop(): void };
  onSignal(signal: "SIGTERM" | "SIGINT", handler: () => void): void;
  exit(code: number): void;
};

// The security watch (spec 7.9) scans once a minute. A row is mailed once it is WATCH_LAG_SECONDS
// old, so a transaction that commits late is still seen. After a restart it goes on from the
// position it stored; only the very first start looks back WATCH_LOOKBACK_MS.
const WATCH_EVERY_MS = 60_000;
const WATCH_LAG_SECONDS = 30;
const WATCH_LOOKBACK_MS = 15 * 60_000;

// Spec 4.6: Settings offers only the (model, effort) pairs that passed the eval for the current
// prompt version.
export function passedScreeningOptions(evals: readonly ScreeningEval[] = SCREENING_EVALS): ScreeningOption[] {
  return evals
    .filter((entry) => entry.promptVersion === PROMPT_VERSION)
    .map((entry) => ({ model: entry.model, effort: entry.effort, passedOn: entry.passedOn, worstCaseMicrousd: worstCaseCostMicrousd(entry.model) }));
}

// Checks that the database role is web with its grants before anything listens (spec 2.10),
// then serves the app on PORT.
export async function runWeb(runtime: WebRuntime): Promise<void> {
  const { env, clock, log } = runtime;
  try {
    await runtime.checkRole(env.databaseUrl);
  } catch (error) {
    if (!(error instanceof RoleCheckError)) throw error;
    // The message names the step and the SQLSTATE only, never the connection string.
    log.error({ event: "web_start_failed", reason: error.message });
    log.flush();
    runtime.exit(1);
    return;
  }
  const pool = runtime.createPool(env.databaseUrl);
  const deps: AppDeps = {
    pool,
    clock,
    keys: createAuthKeys(env.authKey),
    publicOrigin: env.publicOrigin,
    gitSha: env.gitSha,
    assets: await runtime.readManifest(),
    assetFile: runtime.assetFile,
    log,
    background: createBackground(log),
    mail: env.loginSmtp === null ? null : { mailer: runtime.createMailer(env.loginSmtp), from: env.loginSmtp.from.address },
    settingsEnv: env.settingsEnv,
    alertTo: env.alertTo,
    screeningOptions: passedScreeningOptions(),
  };
  const outbox = deps.mail === null ? null : createOutbox(deps, deps.mail);
  const app = createApp(deps, outbox);
  const server = runtime.listen(app.fetch, env.port);

  let timer: { stop(): void } | null = null;
  if (outbox !== null) {
    const since = new Date(clock.now().getTime() - WATCH_LOOKBACK_MS);
    const watch = createSecurityWatch({ ...deps, security: outbox.security, lagSeconds: WATCH_LAG_SECONDS }, since);
    // A failed scan keeps its cursor, so the next minute tries the same rows again.
    timer = runtime.every(WATCH_EVERY_MS, async () => {
      try {
        await watch.scan();
      } catch (error) {
        log.error({ event: "security_watch_failed", err_name: error instanceof Error ? error.name : "unknown" });
      }
    });
  }

  // The deploy stops the container with SIGTERM: no new requests, the running ones and the
  // background work finish, then the mailbox and the pool close. A second signal is ignored.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    timer?.stop();
    await server.close();
    await deps.background.settled();
    deps.mail?.mailer.close();
    await pool.end();
    log.flush();
    runtime.exit(0);
  };
  runtime.onSignal("SIGTERM", () => void stop());
  runtime.onSignal("SIGINT", () => void stop());
}
