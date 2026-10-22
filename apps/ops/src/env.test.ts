import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, loadDatabaseEnv, loadEnv, parseDatabaseEnv, parseEnv } from "./env.js";

const APP_PASSWORD = "0123456789abcdef".repeat(4);
const WORKER_PASSWORD = "1111111111111111".repeat(4);
const DASHBOARD_PASSWORD = "2222222222222222".repeat(4);
const PASSWORDS = {
  POSTGRES_APP_PASSWORD: APP_PASSWORD,
  POSTGRES_WORKER_PASSWORD: WORKER_PASSWORD,
  POSTGRES_DASHBOARD_PASSWORD: DASHBOARD_PASSWORD,
};

function caughtFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (caught) {
    return caught;
  }
  return undefined;
}

describe("parseEnv", () => {
  it("reads a postgres DATABASE_URL and the app, worker and dashboard role passwords", () => {
    expect(
      parseEnv({
        DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
        ...PASSWORDS,
      }),
    ).toEqual({
      databaseUrl: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
      appRolePassword: APP_PASSWORD,
      workerRolePassword: WORKER_PASSWORD,
      dashboardRolePassword: DASHBOARD_PASSWORD,
    });
  });

  it.each([undefined, "", "http://ebay_sniper:sentinel-pw@postgres:5432/ebay_sniper", "not a url sentinel-pw"])(
    "refuses DATABASE_URL %s with an EnvError that names the variable, not the value",
    (value) => {
      const error = caughtFrom(() => parseEnv({ DATABASE_URL: value, ...PASSWORDS }));

      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).message).toBe("invalid environment: DATABASE_URL");
      expect(JSON.stringify(error)).not.toContain("sentinel-pw");
      expect(String((error as EnvError).message)).not.toContain("sentinel-pw");
    },
  );

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["63 hex characters", APP_PASSWORD.slice(1)],
    ["65 hex characters", `${APP_PASSWORD}0`],
    ["upper-case hex", APP_PASSWORD.toUpperCase()],
    ["not hex", `sentinel-app-pw${APP_PASSWORD.slice(15)}`],
  ])("refuses each role password that is %s and names the variable, not the value", (_label, value) => {
    for (const name of Object.keys(PASSWORDS)) {
      const error = caughtFrom(() =>
        parseEnv({ DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper", ...PASSWORDS, [name]: value }),
      );

      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).message).toBe(`invalid environment: ${name}`);
      expect(JSON.stringify(error)).not.toContain("sentinel-app-pw");
      if (value !== undefined && value !== "") {
        expect((error as EnvError).message).not.toContain(value);
      }
    }
  });
});

describe("parseDatabaseEnv", () => {
  it("needs only DATABASE_URL, for the feeds and rules commands", () => {
    expect(parseDatabaseEnv({ DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper" })).toEqual({
      databaseUrl: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
    });
    const error = caughtFrom(() => parseDatabaseEnv({ DATABASE_URL: "http://ebay_sniper:sentinel-pw@postgres/x" }));
    expect((error as EnvError).message).toBe("invalid environment: DATABASE_URL");
  });
});

describe("loadEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the process environment", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper");
    vi.stubEnv("POSTGRES_APP_PASSWORD", APP_PASSWORD);
    vi.stubEnv("POSTGRES_WORKER_PASSWORD", WORKER_PASSWORD);
    vi.stubEnv("POSTGRES_DASHBOARD_PASSWORD", DASHBOARD_PASSWORD);

    expect(loadEnv()).toEqual({
      databaseUrl: "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper",
      appRolePassword: APP_PASSWORD,
      workerRolePassword: WORKER_PASSWORD,
      dashboardRolePassword: DASHBOARD_PASSWORD,
    });
    expect(loadDatabaseEnv()).toEqual({ databaseUrl: "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper" });
  });
});
