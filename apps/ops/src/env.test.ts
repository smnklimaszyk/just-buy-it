import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvError,
  loadAuthKey,
  loadDatabaseEnv,
  loadEnv,
  loadSettingsEnv,
  parseAuthKey,
  parseDatabaseEnv,
  parseEnv,
  parseSettingsEnv,
} from "./env.js";

const APP_PASSWORD = "0123456789abcdef".repeat(4);
const WORKER_PASSWORD = "1111111111111111".repeat(4);
const DASHBOARD_PASSWORD = "2222222222222222".repeat(4);
const WEB_PASSWORD = "3333333333333333".repeat(4);
const PASSWORDS = {
  POSTGRES_APP_PASSWORD: APP_PASSWORD,
  POSTGRES_WORKER_PASSWORD: WORKER_PASSWORD,
  POSTGRES_DASHBOARD_PASSWORD: DASHBOARD_PASSWORD,
  POSTGRES_WEB_PASSWORD: WEB_PASSWORD,
};
const ADMINS = { AUTH_BOOTSTRAP_ADMINS: "info@intra-ai.de" };

function caughtFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (caught) {
    return caught;
  }
  return undefined;
}

describe("parseEnv", () => {
  it("reads a postgres DATABASE_URL, the four role passwords and the bootstrap admins", () => {
    expect(
      parseEnv({
        DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
        ...PASSWORDS,
        ...ADMINS,
      }),
    ).toEqual({
      databaseUrl: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
      appRolePassword: APP_PASSWORD,
      workerRolePassword: WORKER_PASSWORD,
      dashboardRolePassword: DASHBOARD_PASSWORD,
      webRolePassword: WEB_PASSWORD,
      bootstrapAdmins: ["info@intra-ai.de"],
    });
  });

  it("reads the web role password and the bootstrap admins, trimmed, lower-cased, NFC and without repeats", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
      ...PASSWORDS,
      AUTH_BOOTSTRAP_ADMINS: " Info@Intra-AI.de , zoë@example.org,info@intra-ai.de",
    });

    expect(env).toMatchObject({ webRolePassword: WEB_PASSWORD, bootstrapAdmins: ["info@intra-ai.de", "zoë@example.org"] });
    expect(env.bootstrapAdmins[1]).toBe("zoë@example.org".normalize("NFC"));
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["only commas", " , "],
    ["without an @", "sentinel-admin.example.org"],
    ["with two @", "sentinel@admin@example.org"],
    ["with a space inside", "sentinel admin@example.org"],
    ["longer than 254 characters", `sentinel${"x".repeat(250)}@example.org`],
    ["with one bad entry", "info@intra-ai.de,sentinel-admin"],
  ])("refuses AUTH_BOOTSTRAP_ADMINS %s and names the variable, not the value", (_label, value) => {
    const error = caughtFrom(() =>
      parseEnv({ DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper", ...PASSWORDS, AUTH_BOOTSTRAP_ADMINS: value }),
    );

    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).message).toBe("invalid environment: AUTH_BOOTSTRAP_ADMINS");
    expect(JSON.stringify(error)).not.toContain("sentinel");
  });

  it.each([undefined, "", "http://ebay_sniper:sentinel-pw@postgres:5432/ebay_sniper", "not a url sentinel-pw"])(
    "refuses DATABASE_URL %s with an EnvError that names the variable, not the value",
    (value) => {
      const error = caughtFrom(() => parseEnv({ DATABASE_URL: value, ...PASSWORDS, ...ADMINS }));

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
        parseEnv({ DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper", ...PASSWORDS, ...ADMINS, [name]: value }),
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
  it("needs only DATABASE_URL, for every command but migrate", () => {
    expect(parseDatabaseEnv({ DATABASE_URL: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper" })).toEqual({
      databaseUrl: "postgres://ebay_sniper:pw@postgres:5432/ebay_sniper",
    });
    const error = caughtFrom(() => parseDatabaseEnv({ DATABASE_URL: "http://ebay_sniper:sentinel-pw@postgres/x" }));
    expect((error as EnvError).message).toBe("invalid environment: DATABASE_URL");
  });
});

describe("parseSettingsEnv", () => {
  it("reads the two Claude ceilings and the buyer profile, with the worker's defaults when unset or empty", () => {
    expect(
      parseSettingsEnv({ CLAUDE_DAILY_CALL_LIMIT: "25", CLAUDE_DAILY_SPEND_LIMIT_USD: "1.5", BUYER_PROFILE: "private" }),
    ).toEqual({ claudeDailyCallLimit: 25, claudeDailySpendLimitMicrousd: 1_500_000, buyerProfile: "private" });
    expect(parseSettingsEnv({})).toEqual({ claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null });
    expect(parseSettingsEnv({ CLAUDE_DAILY_CALL_LIMIT: "", CLAUDE_DAILY_SPEND_LIMIT_USD: "", BUYER_PROFILE: "" })).toEqual({
      claudeDailyCallLimit: 40,
      claudeDailySpendLimitMicrousd: 2_000_000,
      buyerProfile: null,
    });
  });
});

describe("parseAuthKey", () => {
  it("reads AUTH_KEY as 32 bytes of base64 and refuses any other length without quoting the value", () => {
    const key = Buffer.alloc(32, 7);

    expect(parseAuthKey({ AUTH_KEY: key.toString("base64") })).toEqual(key);
    for (const value of [undefined, "", Buffer.alloc(31, 7).toString("base64"), "sentinel-key-not-base64!"]) {
      const error = caughtFrom(() => parseAuthKey({ AUTH_KEY: value }));
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).message).toBe("invalid environment: AUTH_KEY");
      expect(JSON.stringify(error)).not.toContain("sentinel");
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
    vi.stubEnv("POSTGRES_WORKER_PASSWORD", WORKER_PASSWORD);
    vi.stubEnv("POSTGRES_DASHBOARD_PASSWORD", DASHBOARD_PASSWORD);
    vi.stubEnv("POSTGRES_WEB_PASSWORD", WEB_PASSWORD);
    vi.stubEnv("AUTH_BOOTSTRAP_ADMINS", "info@intra-ai.de");

    expect(loadEnv()).toEqual({
      databaseUrl: "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper",
      appRolePassword: APP_PASSWORD,
      workerRolePassword: WORKER_PASSWORD,
      dashboardRolePassword: DASHBOARD_PASSWORD,
      webRolePassword: WEB_PASSWORD,
      bootstrapAdmins: ["info@intra-ai.de"],
    });
    expect(loadDatabaseEnv()).toEqual({ databaseUrl: "postgresql://ebay_sniper:pw@postgres:5432/ebay_sniper" });
  });

  it("reads the settings ceilings and AUTH_KEY from the process environment", () => {
    vi.stubEnv("CLAUDE_DAILY_CALL_LIMIT", "12");
    vi.stubEnv("CLAUDE_DAILY_SPEND_LIMIT_USD", "0.50");
    vi.stubEnv("BUYER_PROFILE", "company");
    vi.stubEnv("AUTH_KEY", Buffer.alloc(32, 9).toString("base64"));

    expect(loadSettingsEnv()).toEqual({ claudeDailyCallLimit: 12, claudeDailySpendLimitMicrousd: 500_000, buyerProfile: "company" });
    expect(loadAuthKey()).toEqual(Buffer.alloc(32, 9));
  });
});
