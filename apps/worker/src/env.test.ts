import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env.js";

// Not real values; the tests check none of them reaches an error message.
const API_KEY = "sk-ant-env-SENTINEL-KEY-0b7e";
const EBAY_SECRET ="ebay-env-SENTINEL-SECRET-77c1";
const DATABASE_URL = "postgres://worker:db-env-SENTINEL-PASS-1d9e@postgres:5432/ebay_sniper";

const SMTP_PASSWORD = "smtp-env-SENTINEL-PASS-3f2a";
const SMTP = {
  SMTP_HOST: "mail.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "alerts@example.test",
  SMTP_PASSWORD,
  ALERT_FROM: "Just-Buy-It <alerts@example.test>",
};

// The required variables only, as Compose passes them.
const REQUIRED = {
  DATABASE_URL,
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  EBAY_ENVIRONMENT: "production",
  EBAY_CLIENT_ID: "fake-client-id",
  EBAY_CLIENT_SECRET: EBAY_SECRET,
  ITEM_KEY_V1: Buffer.alloc(32, 7).toString("base64"),
  ALERT_TO: "owner@example.test",
};

function failure(source: Record<string, string | undefined>): Error {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("parseEnv accepted the environment");
}

describe("worker env (section 9.1)", () => {
  it("reads the required variables and fills the defaults", () => {
    expect(parseEnv(REQUIRED)).toEqual({
      databaseUrl: DATABASE_URL,
      statementTimeoutMs: 10_000,
      gitSha: REQUIRED.GIT_SHA,
      ebayApiBase: "https://api.ebay.com",
      ebayClientId: "fake-client-id",
      ebayClientSecret: EBAY_SECRET,
      postalCode: "80331",
      itemKeySecret: REQUIRED.ITEM_KEY_V1,
      buyerProfile: "company",
      claude: { apiKey: null, callLimit: 40, spendLimitMicrousd: 2_000_000 },
      settingsEnv: { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null },
      smtp: null,
      alertTo: "owner@example.test",
      logLevel: "info",
    });
  });

  it("names every missing or invalid variable and never a value", () => {
    const error = failure({
      DATABASE_URL: "mysql://worker:db-env-SENTINEL-PASS-1d9e@db/x",
      DB_STATEMENT_TIMEOUT_MS: "0",
      GIT_SHA: "abc",
      EBAY_ENVIRONMENT: "staging",
      EBAY_CLIENT_ID: "fake-client-id",
      EBAY_CLIENT_SECRET: "",
      EBAY_ENDUSERCTX_POSTAL_CODE: "8033",
      ITEM_KEY_V1: Buffer.alloc(16, 7).toString("base64"),
      BUYER_PROFILE: "agency",
      ALERT_TO: "",
      LOG_LEVEL: "loud",
    });
    expect(error).toBeInstanceOf(EnvError);
    expect(error.message).toBe(
      "invalid environment: DATABASE_URL, DB_STATEMENT_TIMEOUT_MS, GIT_SHA, EBAY_ENVIRONMENT, EBAY_CLIENT_SECRET, " +
        "EBAY_ENDUSERCTX_POSTAL_CODE, ITEM_KEY_V1, BUYER_PROFILE, ALERT_TO, LOG_LEVEL",
    );
    expect(error.message).not.toContain("db-env-SENTINEL-PASS-1d9e");
  });

  it("reads the Claude key and both caps; 0 is allowed for either cap", () => {
    const env = parseEnv({
      ...REQUIRED,
      ANTHROPIC_API_KEY: API_KEY,
      CLAUDE_DAILY_CALL_LIMIT: "0",
      CLAUDE_DAILY_SPEND_LIMIT_USD: "2.50",
    });
    expect(env.claude).toEqual({ apiKey: API_KEY, callLimit: 0, spendLimitMicrousd: 2_500_000 });
  });

  it("bounds the settings by the two Claude ceilings and defaults the buyer profile from BUYER_PROFILE (spec 2.5)", () => {
    expect(parseEnv(REQUIRED).settingsEnv).toEqual({
      claudeDailyCallLimit: 40,
      claudeDailySpendLimitMicrousd: 2_000_000,
      buyerProfile: null,
    });
    const env = parseEnv({ ...REQUIRED, CLAUDE_DAILY_CALL_LIMIT: "25", CLAUDE_DAILY_SPEND_LIMIT_USD: "1.50", BUYER_PROFILE: "private" });
    expect(env.settingsEnv).toEqual({ claudeDailyCallLimit: 25, claudeDailySpendLimitMicrousd: 1_500_000, buyerProfile: "private" });
  });

  it("treats the empty strings Compose passes for unset variables as unset", () => {
    const optionalNames = [
      "DB_STATEMENT_TIMEOUT_MS",
      "EBAY_ENDUSERCTX_POSTAL_CODE",
      "BUYER_PROFILE",
      "LOG_LEVEL",
      "ANTHROPIC_API_KEY",
      "CLAUDE_MODEL",
      "CLAUDE_DAILY_CALL_LIMIT",
      "CLAUDE_DAILY_SPEND_LIMIT_USD",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "ALERT_FROM",
    ];
    const env = parseEnv({ ...REQUIRED, ...Object.fromEntries(optionalNames.map((name) => [name, ""])) });
    expect(env).toEqual(parseEnv(REQUIRED));
  });

  it("reads the full SMTP set, with ALERT_FROM as a display name and an address", () => {
    expect(parseEnv({ ...REQUIRED, ...SMTP }).smtp).toEqual({
      host: "mail.example.test",
      port: 587,
      user: "alerts@example.test",
      password: SMTP_PASSWORD,
      from: { name: "Just-Buy-It", address: "alerts@example.test" },
    });
  });

  it("refuses a partial SMTP set, naming the missing variables and no value", () => {
    const error = failure({ ...REQUIRED, SMTP_HOST: SMTP.SMTP_HOST, SMTP_PASSWORD, SMTP_PORT: "" });
    expect(error.message).toBe("invalid environment: SMTP is set partially, missing SMTP_PORT, SMTP_USER, ALERT_FROM");
    expect(error.message).not.toContain(SMTP_PASSWORD);
  });

  it("refuses ALERT_FROM with a line break in the display name as an env error naming the variable and the problem only", () => {
    const value = "Just-Buy-It\r\nBcc: x@example.test <alerts@example.test>";
    const error = failure({ ...REQUIRED, ...SMTP, ALERT_FROM: value });
    expect(error).toBeInstanceOf(EnvError);
    expect(error.message).toBe("invalid environment: ALERT_FROM has a line break in the display name");
    expect(error.message).not.toContain("x@example.test");
  });

  it("never puts a secret into the message, also when it sits in a variable that fails", () => {
    const error = failure({
      ...REQUIRED,
      ...SMTP,
      ANTHROPIC_API_KEY: API_KEY,
      CLAUDE_DAILY_SPEND_LIMIT_USD: API_KEY,
      SMTP_PORT: SMTP_PASSWORD,
      EBAY_ENVIRONMENT: EBAY_SECRET,
      DATABASE_URL: "mysql://worker:db-env-SENTINEL-PASS-1d9e@db/x",
    });
    expect(error.message).toBe("invalid environment: DATABASE_URL, EBAY_ENVIRONMENT, CLAUDE_DAILY_SPEND_LIMIT_USD, SMTP_PORT");
    for (const secret of [API_KEY, SMTP_PASSWORD, EBAY_SECRET, "db-env-SENTINEL-PASS-1d9e"]) expect(error.message).not.toContain(secret);
  });

  it("reads the optional settings", () => {
    const env = parseEnv({
      ...REQUIRED,
      EBAY_ENVIRONMENT: "sandbox",
      DB_STATEMENT_TIMEOUT_MS: "15000",
      EBAY_ENDUSERCTX_POSTAL_CODE: "10115",
      BUYER_PROFILE: "private",
      LOG_LEVEL: "debug",
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "465",
      SMTP_USER: "alerts@example.test",
      SMTP_PASSWORD,
      ALERT_FROM: "alerts@example.test",
    });
    expect(env).toMatchObject({
      ebayApiBase: "https://api.sandbox.ebay.com",
      statementTimeoutMs: 15_000,
      postalCode: "10115",
      buyerProfile: "private",
      logLevel: "debug",
      smtp: { port: 465, from: { name: "", address: "alerts@example.test" } },
    });
  });

  it("ignores CLAUDE_MODEL: the model is the claude.model setting since v2 (spec 10.4)", () => {
    expect(parseEnv({ ...REQUIRED, CLAUDE_MODEL: "claude-opus-5-5" })).toEqual(parseEnv(REQUIRED));
  });

  it("refuses a spend limit below 0 or with more than two decimals and a fractional call limit", () => {
    for (const value of ["-1", "2.555", "2,50", "1e3"]) {
      expect(failure({ ...REQUIRED, CLAUDE_DAILY_SPEND_LIMIT_USD: value }).message).toBe(
        "invalid environment: CLAUDE_DAILY_SPEND_LIMIT_USD",
      );
    }
    expect(parseEnv({ ...REQUIRED, CLAUDE_DAILY_SPEND_LIMIT_USD: "2" }).claude.spendLimitMicrousd).toBe(2_000_000);
    expect(failure({ ...REQUIRED, CLAUDE_DAILY_CALL_LIMIT: "1.5" }).message).toBe("invalid environment: CLAUDE_DAILY_CALL_LIMIT");
  });
});
