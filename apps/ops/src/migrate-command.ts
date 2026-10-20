import { MigrateLockTimeoutError, type MigrateLog, type runMigrations } from "@ebay-sniper/db";
import { EnvError, type Env } from "./env.js";

export type CommandLog = { info: MigrateLog; error: MigrateLog };

export async function runMigrateCommand(deps: {
  loadEnv: () => Env;
  runMigrations: typeof runMigrations;
  log: CommandLog;
}): Promise<number> {
  let password: string | undefined;
  try {
    const env = deps.loadEnv();
    password = new URL(env.databaseUrl).password;
    await deps.runMigrations({ connectionString: env.databaseUrl, log: deps.log.info });
    return 0;
  } catch (error) {
    const exitCode = exitCodeFor(error);
    const { name, message } = describe(error, password);
    // Plain fields: the pino err serializer expects an Error and would log type "Object".
    deps.log.error({ event: "migrate", step: "failed", exit_code: exitCode, err_name: name, err_message: message });
    return exitCode;
  }
}

// 1: any other failure, 2: bad usage or env, 3: the lock stayed taken (spec S1b, section 4.3).
function exitCodeFor(error: unknown): number {
  if (error instanceof EnvError) return 2;
  if (error instanceof MigrateLockTimeoutError) return 3;
  return 1;
}

// Only name and message are logged, and the password is cut out of the message in case a
// driver error quotes the connection string.
function describe(error: unknown, password: string | undefined): { name: string; message: string } {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  let message = error instanceof Error ? error.message : String(error);
  if (password !== undefined && password !== "") {
    for (const form of new Set([password, decodeURIComponent(password)])) {
      message = message.replaceAll(form, "[redacted]");
    }
  }
  return { name, message };
}
