import { checkAppRole, runMigrations, setAppRolePassword } from "@ebay-sniper/db";
import { createLogger, loggerOptions } from "@ebay-sniper/logging";
import { loadEnv } from "./env.js";
import { runMigrateCommand } from "./migrate-command.js";

if (process.argv[2] === "migrate") {
  const logger = createLogger(loggerOptions("info"));
  process.exitCode = await runMigrateCommand({
    loadEnv,
    runMigrations,
    setAppRolePassword,
    checkAppRole,
    log: { info: (entry) => logger.info(entry), error: (entry) => logger.error(entry) },
  });
} else {
  process.stderr.write("usage: node dist/main.js migrate\n");
  process.exitCode = 2;
}
