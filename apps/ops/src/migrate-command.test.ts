import { describe, expect, it, vi } from "vitest";
import {
  AppRoleCheckError,
  MigrateLockTimeoutError,
  MigrationHistoryError,
  type checkAppRole,
  type MigrateLog,
  type runMigrations,
  type setAppRolePassword,
} from "@ebay-sniper/db";
import { EnvError } from "./env.js";
import { runMigrateCommand } from "./migrate-command.js";

const DATABASE_URL = "postgres://ebay_sniper:sentinel-password-4711@postgres:5432/ebay_sniper";
const APP_PASSWORD = "5e171e1a".repeat(8);
const APP_URL = `postgres://app:${APP_PASSWORD}@postgres:5432/ebay_sniper`;

type LogEntry = Parameters<MigrateLog>[0];

function setup(
  fakes: {
    runMigrations?: typeof runMigrations;
    setAppRolePassword?: typeof setAppRolePassword;
    checkAppRole?: typeof checkAppRole;
  } = {},
) {
  const lines: LogEntry[] = [];
  const calls: string[] = [];
  const log = { info: (entry: LogEntry) => lines.push(entry), error: (entry: LogEntry) => lines.push(entry) };
  const migrate = fakes.runMigrations ?? (async () => ({ drizzleApplied: 2, newerThanRelease: 0 }));
  const setPassword = fakes.setAppRolePassword ?? (async () => undefined);
  const check = fakes.checkAppRole ?? (async () => undefined);
  const deps = {
    loadEnv: () => ({ databaseUrl: DATABASE_URL, appRolePassword: APP_PASSWORD }),
    runMigrations: vi.fn<typeof runMigrations>(async (options) => {
      calls.push("runMigrations");
      return migrate(options);
    }),
    setAppRolePassword: vi.fn<typeof setAppRolePassword>(async (...args) => {
      calls.push("setAppRolePassword");
      return setPassword(...args);
    }),
    checkAppRole: vi.fn<typeof checkAppRole>(async (url) => {
      calls.push("checkAppRole");
      return check(url);
    }),
    log,
  };
  return { lines, calls, deps };
}

describe("runMigrateCommand", () => {
  it("migrates, sets the app role password, then checks the app role, and exits 0", async () => {
    const { lines, calls, deps } = setup();

    const code = await runMigrateCommand(deps);

    expect(code).toBe(0);
    expect(calls).toEqual(["runMigrations", "setAppRolePassword", "checkAppRole"]);
    expect(deps.runMigrations).toHaveBeenCalledWith(expect.objectContaining({ connectionString: DATABASE_URL }));
    expect(deps.setAppRolePassword).toHaveBeenCalledWith(DATABASE_URL, APP_PASSWORD);
    expect(deps.checkAppRole).toHaveBeenCalledWith(APP_URL);
    expect(lines).toContainEqual({ event: "migrate", step: "app_role_password_set" });
    expect(lines).toContainEqual({ event: "migrate", step: "app_role_check_passed" });
  });

  it("checks the app role on the same host, port and database as DATABASE_URL", async () => {
    const { deps } = setup();
    deps.loadEnv = () => ({
      databaseUrl: "postgresql://ebay_sniper:pw@db.internal:6543/other_db?sslmode=disable",
      appRolePassword: APP_PASSWORD,
    });

    expect(await runMigrateCommand(deps)).toBe(0);
    const appUrl = new URL(String(deps.checkAppRole.mock.calls[0]?.[0]));
    expect(appUrl.protocol).toBe("postgresql:");
    expect(appUrl.username).toBe("app");
    expect(appUrl.password).toBe(APP_PASSWORD);
    expect(appUrl.host).toBe("db.internal:6543");
    expect(appUrl.pathname).toBe("/other_db");
    expect(appUrl.search).toBe("?sslmode=disable");
  });

  it("exits 1 without the check when setting the app password fails", async () => {
    const { lines, calls, deps } = setup({
      setAppRolePassword: async () => {
        throw new Error('role "app" does not exist');
      },
    });

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(calls).toEqual(["runMigrations", "setAppRolePassword"]);
    expect(lines).toContainEqual(expect.objectContaining({ step: "failed", exit_code: 1, err_name: "Error" }));
    expect(lines).not.toContainEqual(expect.objectContaining({ step: "app_role_password_set" }));
  });

  it("exits 1 with the failed step in the message when the app role check fails", async () => {
    const { lines, deps } = setup({
      checkAppRole: async () => {
        throw new AppRoleCheckError("app role check failed at recordDeletionEvent insert: 42501");
      },
    });

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(lines).toContainEqual({
      event: "migrate",
      step: "failed",
      exit_code: 1,
      err_name: "AppRoleCheckError",
      err_message: "app role check failed at recordDeletionEvent insert: 42501",
    });
    expect(lines).not.toContainEqual(expect.objectContaining({ step: "app_role_check_passed" }));
  });

  it("exits 2 without migrating when the environment is invalid", async () => {
    const { lines, deps } = setup();
    deps.loadEnv = () => {
      throw new EnvError("invalid environment: DATABASE_URL");
    };

    const code = await runMigrateCommand(deps);

    expect(code).toBe(2);
    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(deps.setAppRolePassword).not.toHaveBeenCalled();
    expect(deps.checkAppRole).not.toHaveBeenCalled();
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

  it("exits 3 without the check when the role lock stayed taken while setting the app password", async () => {
    const { calls, deps } = setup({
      setAppRolePassword: async () => {
        throw new MigrateLockTimeoutError("another run held the role lock for 120 attempts");
      },
    });

    expect(await runMigrateCommand(deps)).toBe(3);
    expect(calls).toEqual(["runMigrations", "setAppRolePassword"]);
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
    ["setAppRolePassword", { setAppRolePassword: async (url: string, pw: string) => Promise.reject(new Error(`${url} ${pw}`)) }],
    ["checkAppRole", { checkAppRole: async (url: string) => Promise.reject(new Error(`could not connect to ${url}`)) }],
  ])("never logs either password when a %s error quotes them", async (_label, fakes) => {
    const { lines, deps } = setup(fakes);

    expect(await runMigrateCommand(deps)).toBe(1);
    expect(JSON.stringify(lines)).not.toContain("sentinel-password-4711");
    expect(JSON.stringify(lines)).not.toContain(APP_PASSWORD);
  });
});
