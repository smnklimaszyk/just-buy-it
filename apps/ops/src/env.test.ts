import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, loadEnv, parseEnv } from "./env.js";

const APP_PASSWORD = "0123456789abcdef".repeat(4);

function caughtFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (caught) {
    return caught;
  }
  return undefined;
}

describe("parseEnv", () => {
  it("reads a postgres DATABASE_URL and the app role password", () => {
    expect(
      parseEnv({
        DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
        POSTGRES_APP_PASSWORD: APP_PASSWORD,
      }),
    ).toEqual({
      databaseUrl: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
      appRolePassword: APP_PASSWORD,
    });
  });

  it.each([undefined, "", "http://ebay_sniper:sentinel-pw@postgres:5432/ebay_sniper", "not a url sentinel-pw"])(
    "refuses DATABASE_URL %s with an EnvError that names the variable, not the value",
    (value) => {
      const error = caughtFrom(() => parseEnv({ DATABASE_URL: value, POSTGRES_APP_PASSWORD: APP_PASSWORD }));

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
  ])("refuses POSTGRES_APP_PASSWORD that is %s and names the variable, not the value", (_label, value) => {
    const error = caughtFrom(() =>
      parseEnv({ DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper", POSTGRES_APP_PASSWORD: value }),
    );

    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).message).toBe("invalid environment: POSTGRES_APP_PASSWORD");
    expect(JSON.stringify(error)).not.toContain("sentinel-app-pw");
    if (value !== undefined && value !== "") {
      expect((error as EnvError).message).not.toContain(value);
    }
  });
});

describe("loadEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the process environment", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper");
    vi.stubEnv("POSTGRES_APP_PASSWORD", APP_PASSWORD);

    expect(loadEnv()).toEqual({
      databaseUrl: "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper",
      appRolePassword: APP_PASSWORD,
    });
  });
});
