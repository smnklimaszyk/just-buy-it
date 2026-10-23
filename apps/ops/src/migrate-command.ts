import { MigrateLockTimeoutError, type checkAppRole, type MigrateLog, type runMigrations } from "@ebay-sniper/db";
import type {
  bootstrapAdmins,
  checkDashboardRole,
  checkWebRole,
  checkWorkerRole,
  migrateQueue,
  ServiceRole,
  setRolePassword,
} from "@ebay-sniper/db/queue";
import { EnvError, type Env } from "./env.js";

export type CommandLog = { info: MigrateLog; error: MigrateLog };

// Runs on every deploy (sections 2.2 and 2.5, spec 2.10 and 7.8). Under the migrate lock: the
// Drizzle migrations, the passwords of app, worker, dashboard and web, the pg-boss schema and
// queues, then the bootstrap admins. After it: a check as each role. A failure stops the deploy
// before any container is replaced.
export async function runMigrateCommand(deps: {
  loadEnv: () => Env;
  runMigrations: typeof runMigrations;
  setRolePassword: typeof setRolePassword;
  migrateQueue: typeof migrateQueue;
  bootstrapAdmins: typeof bootstrapAdmins;
  checkAppRole: typeof checkAppRole;
  checkWorkerRole: typeof checkWorkerRole;
  checkDashboardRole: typeof checkDashboardRole;
  checkWebRole: typeof checkWebRole;
  log: CommandLog;
}): Promise<number> {
  const passwords: string[] = [];
  try {
    const env = deps.loadEnv();
    passwords.push(
      new URL(env.databaseUrl).password,
      env.appRolePassword,
      env.workerRolePassword,
      env.dashboardRolePassword,
      env.webRolePassword,
    );
    const roles: [ServiceRole, string][] = [
      ["app", env.appRolePassword],
      ["worker", env.workerRolePassword],
      ["dashboard", env.dashboardRolePassword],
      ["web", env.webRolePassword],
    ];
    await deps.runMigrations({
      connectionString: env.databaseUrl,
      log: deps.log.info,
      afterDrizzle: async (client, logStep) => {
        for (const [role, password] of roles) {
          await deps.setRolePassword(env.databaseUrl, role, password);
          logStep(`${role}_role_password_set`);
        }
        const queue = await deps.migrateQueue(client);
        logStep("pgboss_installed", {
          version: queue.version,
          schema_created: queue.schemaCreated,
          queues_created: queue.queuesCreated.length,
        });
        // A count only: the log never carries a full address (spec 7.9).
        const admins = await deps.bootstrapAdmins(client, env.bootstrapAdmins);
        logStep("bootstrap_admins", { added: admins.added });
      },
    });
    await deps.checkAppRole(roleUrl(env.databaseUrl, "app", env.appRolePassword));
    deps.log.info({ event: "migrate", step: "app_role_check_passed" });
    await deps.checkWorkerRole(roleUrl(env.databaseUrl, "worker", env.workerRolePassword));
    deps.log.info({ event: "migrate", step: "worker_role_check_passed" });
    await deps.checkDashboardRole(roleUrl(env.databaseUrl, "dashboard", env.dashboardRolePassword));
    deps.log.info({ event: "migrate", step: "dashboard_role_check_passed" });
    await deps.checkWebRole(roleUrl(env.databaseUrl, "web", env.webRolePassword));
    deps.log.info({ event: "migrate", step: "web_role_check_passed" });
    return 0;
  } catch (error) {
    const exitCode = exitCodeFor(error);
    const { name, message } = describe(error, passwords);
    // Plain fields: the pino err serializer expects an Error and would log type "Object".
    deps.log.error({ event: "migrate", step: "failed", exit_code: exitCode, err_name: name, err_message: message });
    return exitCode;
  }
}

// The URL the role's service uses: same host, port and database as DATABASE_URL.
function roleUrl(databaseUrl: string, role: ServiceRole, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

// 1: any other failure, 2: bad usage or env, 3: the lock stayed taken (spec S1b, section 4.3).
function exitCodeFor(error: unknown): number {
  if (error instanceof EnvError) return 2;
  if (error instanceof MigrateLockTimeoutError) return 3;
  return 1;
}

// Only name and message are logged, and every password is cut out of the message in case a
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
