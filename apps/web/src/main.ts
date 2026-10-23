import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWebRole, createPool, SERVICE_POOLS } from "@ebay-sniper/db";
import { createLogger, loggerOptions } from "@ebay-sniper/logging";
import { createSmtpMailer } from "@ebay-sniper/notify";
import { getRequestListener } from "@hono/node-server";
import { assetFiles } from "./asset-files.js";
import { systemClock } from "./clock.js";
import { EnvError, loadEnv, type WebEnv } from "./env.js";
import { runWeb } from "./start.js";

// `node dist/main.js` serves the web app; dist/assets sits next to this file.

let env: WebEnv;
try {
  env = loadEnv();
} catch (error) {
  if (!(error instanceof EnvError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const logger = createLogger(loggerOptions(env.logLevel));
const log = {
  info: (entry: Record<string, unknown>) => logger.info(entry),
  warn: (entry: Record<string, unknown>) => logger.warn(entry),
  error: (entry: Record<string, unknown>) => logger.error(entry),
  flush: () => logger.flush(),
};
const assets = assetFiles(join(dirname(fileURLToPath(import.meta.url)), "assets"));

try {
  await runWeb({
    env,
    clock: systemClock,
    log,
    checkRole: checkWebRole,
    createPool: (connectionString) =>
      createPool({
        connectionString,
        max: SERVICE_POOLS.web,
        applicationName: "ebay-sniper-web",
        onError: (error) => log.error({ event: "db_pool_error", err_name: error.name }),
      }),
    readManifest: () => assets.readManifest(),
    assetFile: (path) => assets.file(path),
    createMailer: (config) => createSmtpMailer(config),
    listen: (fetch, port) => {
      const server = createServer(getRequestListener(fetch)).listen(port, "0.0.0.0");
      log.info({ event: "web_listening", port });
      return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    },
    every: (ms, task) => {
      const timer = setInterval(() => void task(), ms);
      timer.unref();
      return { stop: () => clearInterval(timer) };
    },
    // process.on, not once: a second signal must reach the shutdown handler, which ignores it,
    // instead of Node's default, which would end the process at once.
    onSignal: (signal, handler) => void process.on(signal, handler),
    exit: (code) => process.exit(code),
  });
} catch (error) {
  // By the error's name only: a database error can quote the connection string.
  log.error({ event: "web_start_failed", err_name: error instanceof Error ? error.name : "unknown" });
  log.flush();
  process.exit(1);
}
