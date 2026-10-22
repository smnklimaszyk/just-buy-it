import { checkAppRole, createPool, runMigrations } from "@ebay-sniper/db";
import { checkDashboardRole, checkWorkerRole, migrateQueue, setRolePassword } from "@ebay-sniper/db/queue";
import { createLogger, loggerOptions } from "@ebay-sniper/logging";
import type { OpsDeps } from "./change.js";
import { systemClock } from "./clock.js";
import { loadDatabaseEnv, loadEnv } from "./env.js";
import { runFeedsCommand } from "./feeds-command.js";
import { runMigrateCommand } from "./migrate-command.js";
import { runRulesCommand } from "./rules-command.js";

const USAGE =
  "usage: node dist/main.js migrate | feeds pause|resume <feed> | feeds set <feed> <field> <value> | rules list | rules set <segment> <field> <value>\n";

const [command, ...args] = process.argv.slice(2);
const logger = createLogger(loggerOptions("info"));
const log = { info: (entry: object) => logger.info(entry), error: (entry: object) => logger.error(entry) };

const opsDeps: OpsDeps = {
  loadEnv: loadDatabaseEnv,
  createPool,
  clock: systemClock,
  out: (line) => process.stdout.write(`${line}\n`),
  log,
};

if (command === "migrate" && args.length === 0) {
  process.exitCode = await runMigrateCommand({
    loadEnv,
    runMigrations,
    setRolePassword,
    migrateQueue,
    checkAppRole,
    checkWorkerRole,
    checkDashboardRole,
    log,
  });
} else if (command === "feeds") {
  process.exitCode = await runFeedsCommand(args, opsDeps);
} else if (command === "rules") {
  process.exitCode = await runRulesCommand(args, opsDeps);
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
