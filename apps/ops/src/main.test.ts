import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./migrate-command.js", () => ({ runMigrateCommand: vi.fn(async () => 3) }));

async function runMain(argv: string[]): Promise<void> {
  vi.resetModules();
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "main.js", ...argv]);
  await import("./main.js");
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("main", () => {
  it("prints the usage and exits 2 for an unknown command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await runMain(["drop-everything"]);

    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith("usage: node dist/main.js migrate\n");
  });

  it("runs the migrate command with the real env loader and exits with its code", async () => {
    await runMain(["migrate"]);

    const { runMigrateCommand } = await import("./migrate-command.js");
    const { loadEnv } = await import("./env.js");
    expect(process.exitCode).toBe(3);
    expect(runMigrateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ loadEnv, runMigrations: expect.any(Function), log: expect.any(Object) }),
    );
  });

  it("passes the migrate and app role functions of the db package to the migrate command", async () => {
    await runMain(["migrate"]);

    const { runMigrateCommand } = await import("./migrate-command.js");
    const db = await import("@ebay-sniper/db");
    expect(runMigrateCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        runMigrations: db.runMigrations,
        setAppRolePassword: db.setAppRolePassword,
        checkAppRole: db.checkAppRole,
      }),
    );
  });
});
