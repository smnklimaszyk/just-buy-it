import {
  MigrateLockTimeoutError,
  type checkAppRole,
  type MigrateLog,
  type runMigrations,
  type setAppRolePassword,
} from "@ebay-sniper/db";
import { EnvError, type Env } from "./env.js";

export type CommandLog = { info: MigrateLog; error: MigrateLog };

// Runs on every deploy, in this order: migrations, the app role password, the app role check
// (spec S3, section 2.3). A failure stops the deploy before the server is replaced.
export async function runMigrateCommand(deps: {
  loadEnv: () => Env;
  runMigrations: typeof runMigrations;
  setAppRolePassword: typeof setAppRolePassword;
  checkAppRole: typeof checkAppRole;
  log: CommandLog;
}): Promise<number> {
  const passwords: string[] = [];
  try {
    const env = deps.loadEnv();
    passwords.push(new URL(env.databaseUrl).password, env.appRolePassword);
    await deps.runMigrations({ connectionString: env.databaseUrl, log: deps.log.info });
    await deps.setAppRolePassword(env.databaseUrl, env.appRolePassword);
    deps.log.info({ event: "migrate", step: "app_role_password_set" });
    await deps.checkAppRole(appRoleUrl(env));
    deps.log.info({ event: "migrate", step: "app_role_check_passed" });
    return 0;
  } catch (error) {
    const exitCode = exitCodeFor(error);
    const { name, message } = describe(error, passwords);
    // Plain fields: the pino err serializer expects an Error and would log type "Object".
    deps.log.error({ event: "migrate", step: "failed", exit_code: exitCode, err_name: name, err_message: message });
    return exitCode;
  }
}

// The URL the server uses: same host, port and database as DATABASE_URL, user app.
function appRoleUrl(env: Env): string {
  const url = new URL(env.databaseUrl);
  url.username = "app";
  url.password = env.appRolePassword;
  return url.toString();
}

// 1: any other failure, 2: bad usage or env, 3: the lock stayed taken (spec S1b, section 4.3).
function exitCodeFor(error: unknown): number {
  if (error instanceof EnvError) return 2;
  if (error instanceof MigrateLockTimeoutError) return 3;
  return 1;
}

// Only name and message are logged, and both passwords are cut out of the message in case a
// driver error quotes a connection string.
function describe(error: unknown, passwords: string[]): { name: string; message: string } {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  let message = error instanceof Error ? error.message : String(error);
  for (const password of passwords.filter((value) => value !== "")) {
    for (const form of new Set([password, decodeURIComponent(password)])) {
      message = message.replaceAll(form, "[redacted]");
    }
  }
  return { name, message };
}
