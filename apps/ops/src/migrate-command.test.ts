import { describe, expect, it, vi } from "vitest";
import { MigrateLockTimeoutError, MigrationHistoryError, type MigrateLog, type runMigrations } from "@ebay-sniper/db";
import { EnvError } from "./env.js";
import { runMigrateCommand } from "./migrate-command.js";

const DATABASE_URL = "postgres://ebay_sniper:sentinel-password-4711@postgres:5432/ebay_sniper";

type LogEntry = Parameters<MigrateLog>[0];

function setup(fake: typeof runMigrations) {
  const lines: LogEntry[] = [];
  const log = { info: (entry: LogEntry) => lines.push(entry), error: (entry: LogEntry) => lines.push(entry) };
  const run = vi.fn(fake);
  return { lines, log, run, loadEnv: () => ({ databaseUrl: DATABASE_URL }) };
}

describe("runMigrateCommand", () => {
  it("exits 0 after the migrations ran against DATABASE_URL", async () => {
    const { log, run, loadEnv } = setup(async () => ({ drizzleApplied: 2, newerThanRelease: 0 }));

    const code = await runMigrateCommand({ loadEnv, runMigrations: run, log });

    expect(code).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ connectionString: DATABASE_URL }));
  });

  it("exits 2 without migrating when the environment is invalid", async () => {
    const { lines, log, run } = setup(async () => ({ drizzleApplied: 0, newerThanRelease: 0 }));
    const loadEnv = () => {
      throw new EnvError("invalid environment: DATABASE_URL");
    };

    const code = await runMigrateCommand({ loadEnv, runMigrations: run, log });

    expect(code).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "migrate", step: "failed", exit_code: 2, err_name: "EnvError" }),
    );
  });

  it("exits 3 when another runner held the lock", async () => {
    const { log, run, loadEnv } = setup(async () => {
      throw new MigrateLockTimeoutError("another migrate run held the lock for 120 attempts");
    });

    expect(await runMigrateCommand({ loadEnv, runMigrations: run, log })).toBe(3);
  });

  it.each([
    new MigrationHistoryError("applied migration 0000_foundations was edited"),
    new Error("connect ETIMEDOUT 10.255.255.1:5432"),
  ])("exits 1 on any other failure: $message", async (failure) => {
    const { lines, log, run, loadEnv } = setup(async () => {
      throw failure;
    });

    expect(await runMigrateCommand({ loadEnv, runMigrations: run, log })).toBe(1);
    expect(lines).toContainEqual(
      expect.objectContaining({ step: "failed", exit_code: 1, err_name: failure.constructor.name, err_message: failure.message }),
    );
  });

  it("never logs the database password, even when an error message carries the URL", async () => {
    const { lines, log, run, loadEnv } = setup(async (options) => {
      options.log({ event: "migrate", step: "lock_acquired", attempts: 1 });
      throw new Error(`could not connect to ${DATABASE_URL}`);
    });

    expect(await runMigrateCommand({ loadEnv, runMigrations: run, log })).toBe(1);
    expect(lines.length).toBeGreaterThan(1);
    expect(JSON.stringify(lines)).not.toContain("sentinel-password-4711");
  });
});
