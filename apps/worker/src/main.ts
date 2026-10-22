import { createLogger, loggerOptions } from "@ebay-sniper/logging";
import { runMain } from "./cli.js";
import { systemClock } from "./clock.js";
import { loadEnv } from "./env.js";

// `node dist/main.js` runs the worker; `node dist/main.js mail:test` sends one test email.
await runMain({
  argv: process.argv.slice(2),
  loadEnv,
  clock: systemClock,
  stdout: (line) => void process.stdout.write(`${line}\n`),
  stderr: (line) => void process.stderr.write(`${line}\n`),
  exit: (code) => process.exit(code),
  fetchFn: fetch,
  createLog: (level) => {
    const logger = createLogger(loggerOptions(level));
    return {
      info: (entry) => logger.info(entry),
      warn: (entry) => logger.warn(entry),
      error: (entry) => logger.error(entry),
      flush: () => logger.flush(),
    };
  },
  // process.on, not once: a second signal must reach the shutdown handler, which ignores it,
  // instead of Node's default, which would end the process at once.
  onSignal: (signal, handler) => void process.on(signal, handler),
  aliveFile: "/tmp/worker-alive",
});
