import { describe, expect, it, vi } from "vitest";
import {
  AppRoleCheckError,
  MigrateLockTimeoutError,
  MigrationHistoryError,
  type checkAppRole,
  type MigrateLog,
  type runMigrations,
} from "@ebay-sniper/db";
import {
  QueueSchemaVersionError,
  RoleCheckError,
  type checkDashboardRole,
  type checkWorkerRole,
  type migrateQueue,
  type setRolePassword,
} from "@ebay-sniper/db/queue";
import { EnvError } from "./env.js";
import { runMigrateCommand } from "./migrate-command.js";

const DATABASE_URL = "postgres://ebay_sniper:sentinel-password-4711@postgres:5432/ebay_sniper";
const APP_PASSWORD = "5e171e1a".repeat(8);
const WORKER_PASSWORD = "5e171e1b".repeat(8);
const DASHBOARD_PASSWORD = "5e171e1c".repeat(8);
const ENV = {
  databaseUrl: DATABASE_URL,
  appRolePassword: APP_PASSWORD,
  workerRolePassword: WORKER_PASSWORD,
  dashboardRolePassword: DASHBOARD_PASSWORD,
};

type LogEntry = Parameters<MigrateLog>[0];
type MigrateClient = Parameters<NonNullable<Parameters<typeof runMigrations>[0]["afterDrizzle"]>>[0];

// The runner's client as the fakes pass it along; nothing here queries it.
const MIGRATE_CLIENT = { stands_in_for: "the migrate runner's client" } as unknown as MigrateClient;

type Fakes = {
  runMigrations?: typeof runMigrations;
  setRolePassword?: typeof setRolePassword;
  migrateQueue?: typeof migrateQueue;
  checkAppRole?: typeof checkAppRole;
  checkWorkerRole?: typeof checkWorkerRole;
  checkDashboardRole?: typeof checkDashboardRole;
};

function setup(fakes: Fakes = {}) {
  const lines: LogEntry[] = [];
  const calls: string[] = [];
  const log = { info: (entry: LogEntry) => lines.push(entry), error: (entry: LogEntry) => lines.push(entry) };
  // Like the real runner: the post-Drizzle step runs inside, with a step logger.
  const migrate: typeof runMigrations =
    fakes.runMigrations ??
    (async (options) => {
      options.log({ event: "migrate", step: "drizzle", applied: 2 });
      await options.afterDrizzle?.(MIGRATE_CLIENT, (step, fields = {}) => options.log({ event: "migrate", step, ...fields }));
      return { drizzleApplied: 2, newerThanRelease: 0 };
    });
  const deps = {
    loadEnv: () => ENV,
    runMigrations: vi.fn<typeof runMigrations>(async (options) => {
      calls.push("runMigrations");
      return migrate(options);
    }),
    setRolePassword: vi.fn<typeof setRolePassword>(async (url, role, password) => {
      calls.push(`setRolePassword ${role}`);
      return (fakes.setRolePassword ?? (async () => undefined))(url, role, password);
    }),
    migrateQueue: vi.fn<typeof migrateQueue>(async (client) => {
      calls.push("migrateQueue");
      return (fakes.migrateQueue ?? (async () => ({ schemaCreated: true, version: 46, queuesCreated: ["poll.dead", "poll"] })))(
        client,
      );
    }),
    checkAppRole: vi.fn<typeof checkAppRole>(async (url) => {
      calls.push("checkAppRole");
      return (fakes.checkAppRole ?? (async () => undefined))(url);
    }),
    checkWorkerRole: vi.fn<typeof checkWorkerRole>(async (url) => {
      calls.push("checkWorkerRole");
      return (fakes.checkWorkerRole ?? (async () => undefined))(url);
    }),
    checkDashboardRole: vi.fn<typeof checkDashboardRole>(async (url) => {
      calls.push("checkDashboardRole");
      return (fakes.checkDashboardRole ?? (async () => undefined))(url);
    }),
    log,
  };
  return { lines, calls, deps };
}

describe("runMigrateCommand", () => {
  it("migrates, sets the three role passwords and installs pg-boss under the migrate lock, then checks each role", async () => {
    const { lines, calls, deps } = setup();

    const code = await runMigrateCommand(deps);

    expect(code).toBe(0);
    expect(calls).toEqual([
      "runMigrations",
      "setRolePassword app",
      "setRolePassword worker",
      "setRolePassword dashboard",
      "migrateQueue",
      "checkAppRole",
      "checkWorkerRole",
      "checkDashboardRole",
    ]);
    expect(deps.runMigrations).toHaveBeenCalledWith(expect.objectContaining({ connectionString: DATABASE_URL }));
    expect(deps.setRolePassword.mock.calls).toEqual([
      [DATABASE_URL, "app", APP_PASSWORD],
      [DATABASE_URL, "worker", WORKER_PASSWORD],
      [DATABASE_URL, "dashboard", DASHBOARD_PASSWORD],
    ]);
    expect(deps.migrateQueue).toHaveBeenCalledWith(MIGRATE_CLIENT);
    expect(deps.checkAppRole).toHaveBeenCalledWith(`postgres://app:${APP_PASSWORD}@postgres:5432/ebay_sniper`);
    expect(deps.checkWorkerRole).toHaveBeenCalledWith(`postgres://worker:${WORKER_PASSWORD}@postgres:5432/ebay_sniper`);
    expect(deps.checkDashboardRole).toHaveBeenCalledWith(
      `postgres://dashboard:${DASHBOARD_PASSWORD}@postgres:5432/ebay_sniper`,
    );
    expect(lines.map((line) => line.step)).toEqual([
      "drizzle",
      "app_role_password_set",
      "worker_role_password_set",
      "dashboard_role_password_set",
      "pgboss_installed",
      "app_role_check_passed",
      "worker_role_check_passed",
      "dashboard_role_check_passed",
    ]);
    expect(lines).toContainEqual({ event: "migrate", step: "pgboss_installed", version: 46, schema_created: true, queues_created: 2 });
  });

  it("checks each role on the same host, port and database as DATABASE_URL", async () => {
    const { deps } = setup();
    deps.loadEnv = () => ({ ...ENV, databaseUrl: "postgresql://ebay_sniper:pw@db.internal:6543/other_db?sslmode=disable" });

    expect(await runMigrateCommand(deps)).toBe(0);
    const urls = [deps.checkAppRole, deps.checkWorkerRole, deps.checkDashboardRole].map(
      (check) => new URL(String(check.mock.calls[0]?.[0])),
    );
    expect(urls.map((url) => [url.username, url.password])).toEqual([
      ["app", APP_PASSWORD],
      ["worker", WORKER_PASSWORD],
      ["dashboard", DASHBOARD_PASSWORD],
    ]);
    for (const url of urls) {
      expect(url.protocol).toBe("postgresql:");
      expect(url.host).toBe("db.internal:6543");
      expect(url.pathname).toBe("/other_db");
      expect(url.search).toBe("?sslmode=disable");
    }
  });

  it("exits 1 before pg-boss and the checks when setting a role password fails", async () => {
    const { lines, calls, deps } = setup({
      setRolePassword: async (_url, role) => {
        if (role === "worker") throw new Error('role "worker" does not exist');
      },
    });

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(calls).toEqual(["runMigrations", "setRolePassword app", "setRolePassword worker"]);
    expect(lines).toContainEqual(expect.objectContaining({ step: "failed", exit_code: 1, err_name: "Error" }));
    expect(lines).not.toContainEqual(expect.objectContaining({ step: "worker_role_password_set" }));
  });

  it.each([
    ["schema 45", new QueueSchemaVersionError("pg-boss schema 45 needs an upgrade path; not built in the MVP")],
    ["schema 47", new QueueSchemaVersionError("pg-boss schema 47: database is newer than this release")],
  ])("exits 1 without the role checks when the installed pg-boss is %s", async (_label, failure) => {
    const { lines, calls, deps } = setup({
      migrateQueue: async () => {
        throw failure;
      },
    });

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(calls).not.toContain("checkAppRole");
    expect(lines).toContainEqual({
      event: "migrate",
      step: "failed",
      exit_code: 1,
      err_name: "QueueSchemaVersionError",
      err_message: failure.message,
    });
  });

  it.each([
    ["checkAppRole", new AppRoleCheckError("app role check failed at recordDeletionEvent insert: 42501"), ["checkAppRole"]],
    ["checkWorkerRole", new RoleCheckError("worker role check failed at pgboss.version: 42P01"), ["checkAppRole", "checkWorkerRole"]],
    [
      "checkDashboardRole",
      new RoleCheckError("dashboard role check failed at insert app.feed: expected 42501, got success"),
      ["checkAppRole", "checkWorkerRole", "checkDashboardRole"],
    ],
  ] as const)("exits 1 with the failed step in the message when %s fails", async (name, failure, checks) => {
    const { lines, calls, deps } = setup({
      [name]: async () => {
        throw failure;
      },
    });

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(calls.filter((call) => call.startsWith("check"))).toEqual(checks);
    expect(lines).toContainEqual({
      event: "migrate",
      step: "failed",
      exit_code: 1,
      err_name: failure.constructor.name,
      err_message: failure.message,
    });
  });

  it("exits 2 without migrating when the environment is invalid", async () => {
    const { lines, calls, deps } = setup();
    deps.loadEnv = () => {
      throw new EnvError("invalid environment: POSTGRES_WORKER_PASSWORD");
    };

    expect(await runMigrateCommand(deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "migrate", step: "failed", exit_code: 2, err_name: "EnvError" }),
    );
  });

  it("exits 3 when another runner held the lock", async () => {
    const { calls, deps } = setup({
      runMigrations: async () => {
        throw new MigrateLockTimeoutError("another migrate run held the lock for 120 attempts");
      },
    });

    expect(await runMigrateCommand(deps)).toBe(3);
    expect(calls).toEqual(["runMigrations"]);
  });

  it("exits 3 without the checks when the role lock stayed taken while setting a password", async () => {
    const { calls, deps } = setup({
      setRolePassword: async () => {
        throw new MigrateLockTimeoutError("another session held the role lock for 120 attempts");
      },
    });

    expect(await runMigrateCommand(deps)).toBe(3);
    expect(calls).toEqual(["runMigrations", "setRolePassword app"]);
  });

  it.each([
    new MigrationHistoryError("applied migration 0000_foundations was edited"),
    new Error("connect ETIMEDOUT 10.255.255.1:5432"),
  ])("exits 1 on any other failure and goes no further: $message", async (failure) => {
    const { lines, calls, deps } = setup({
      runMigrations: async () => {
        throw failure;
      },
    });

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(calls).toEqual(["runMigrations"]);
    expect(lines).toContainEqual(
      expect.objectContaining({ step: "failed", exit_code: 1, err_name: failure.constructor.name, err_message: failure.message }),
    );
  });

  it("never logs the database password, even when an error message carries the URL", async () => {
    const { lines, deps } = setup({
      runMigrations: async (options) => {
        options.log({ event: "migrate", step: "lock_acquired", attempts: 1 });
        throw new Error(`could not connect to ${DATABASE_URL}`);
      },
    });

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(lines.length).toBeGreaterThan(1);
    expect(JSON.stringify(lines)).not.toContain("sentinel-password-4711");
  });

  it.each([
    ["setRolePassword", { setRolePassword: async (url: string, _role: string, pw: string) => Promise.reject(new Error(`${url} ${pw}`)) }],
    ["checkAppRole", { checkAppRole: async (url: string) => Promise.reject(new Error(`could not connect to ${url}`)) }],
    ["checkWorkerRole", { checkWorkerRole: async (url: string) => Promise.reject(new Error(`could not connect to ${url}`)) }],
    ["checkDashboardRole", { checkDashboardRole: async (url: string) => Promise.reject(new Error(`could not connect to ${url}`)) }],
  ])("never logs a password when a %s error quotes it", async (_label, fakes) => {
    const { lines, deps } = setup(fakes);

    expect(await runMigrateCommand(deps)).toBe(1);
    const logged = JSON.stringify(lines);
    for (const secret of ["sentinel-password-4711", APP_PASSWORD, WORKER_PASSWORD, DASHBOARD_PASSWORD]) {
      expect(logged).not.toContain(secret);
    }
  });
});
