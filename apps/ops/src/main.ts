import { checkAppRole, createPool, runMigrations } from "@ebay-sniper/db";
import {
  bootstrapAdmins,
  checkDashboardRole,
  checkWebRole,
  checkWorkerRole,
  migrateQueue,
  setRolePassword,
} from "@ebay-sniper/db/queue";
import { passedChoices, PROMPT_VERSION } from "@ebay-sniper/llm/catalog";
import { createLogger, loggerOptions } from "@ebay-sniper/logging";
import { runAuthCommand } from "./auth-command.js";
import { terminalQuestion, type OpsDeps } from "./change.js";
import { systemClock } from "./clock.js";
import { loadAuthKey, loadDatabaseEnv, loadEnv, loadSettingsEnv } from "./env.js";
import { runMigrateCommand } from "./migrate-command.js";
import { runProductsCommand } from "./products-command.js";
import { runPlanCommand, runSearchesCommand } from "./searches-command.js";
import { runSettingsCommand } from "./settings-command.js";

const USAGE =
  "usage: node dist/main.js migrate | products list|show|set|pause|resume|archive|pause-all|import-legacy ... | searches list | plan | settings list|set ... | auth users|user|sessions|unlock|code ...\n";

const [command, ...args] = process.argv.slice(2);
const logger = createLogger(loggerOptions("info"));
const log = { info: (entry: object) => logger.info(entry), error: (entry: object) => logger.error(entry) };

const opsDeps: OpsDeps = {
  loadEnv: loadDatabaseEnv,
  loadSettingsEnv,
  loadAuthKey,
  screeningEvals: passedChoices(PROMPT_VERSION),
  createPool,
  clock: systemClock,
  out: (line) => process.stdout.write(`${line}\n`),
  // `ops auth code` asks before it prints a code.
  ask: terminalQuestion(process.stdin, process.stdout),
  log,
};

if (command === "migrate" && args.length === 0) {
  process.exitCode = await runMigrateCommand({
    loadEnv,
    runMigrations,
    setRolePassword,
    migrateQueue,
    bootstrapAdmins,
    checkAppRole,
    checkWorkerRole,
    checkDashboardRole,
    checkWebRole,
    log,
  });
} else if (command === "products") {
  process.exitCode = await runProductsCommand(args, opsDeps);
} else if (command === "settings") {
  process.exitCode = await runSettingsCommand(args, opsDeps);
} else if (command === "searches") {
  process.exitCode = await runSearchesCommand(args, opsDeps);
} else if (command === "plan") {
  process.exitCode = await runPlanCommand(args, opsDeps);
} else if (command === "auth") {
  process.exitCode = await runAuthCommand(args, opsDeps);
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
