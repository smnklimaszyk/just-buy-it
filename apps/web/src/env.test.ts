import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env.js";

// Not real values; the tests check none of them reaches an error message.
const DATABASE_URL = "postgres://web:db-env-SENTINEL-PASS-2c4b@postgres:5432/ebay_sniper";
const AUTH_KEY = Buffer.alloc(32, 9).toString("base64");
const LOGIN_SMTP_PASSWORD = "login-smtp-env-SENTINEL-PASS-8e1d";
const LOGIN_SMTP = {
  LOGIN_SMTP_HOST: "mail.example.test",
  LOGIN_SMTP_PORT: "587",
  LOGIN_SMTP_USER: "noreply@intra-ai.de",
  LOGIN_SMTP_PASSWORD,
  LOGIN_FROM: "Just-Buy-It <noreply@intra-ai.de>",
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

// The required variables only, as Compose passes them.
const REQUIRED = {
  PORT: "3000",
  DATABASE_URL,
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  AUTH_KEY,
  PUBLIC_ORIGIN: "https://deals.intra-ai.de",
  ALERT_TO: "owner@example.test",
};

describe("web env", () => {
  it("reads the required variables and fills the defaults", () => {
    expect(parseEnv(REQUIRED)).toEqual({
      port: 3000,
      databaseUrl: DATABASE_URL,
      gitSha: REQUIRED.GIT_SHA,
      authKey: Buffer.alloc(32, 9),
      publicOrigin: "https://deals.intra-ai.de",
      loginSmtp: null,
      settingsEnv: { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null },
      alertTo: "owner@example.test",
      logLevel: "info",
    });
  });

  it("takes the sign-in mailbox from LOGIN_SMTP_* and LOGIN_FROM, all five or none (owner decision 2)", () => {
    expect(parseEnv({ ...REQUIRED, ...LOGIN_SMTP }).loginSmtp).toEqual({
      host: "mail.example.test",
      port: 587,
      user: "noreply@intra-ai.de",
      password: LOGIN_SMTP_PASSWORD,
      from: { name: "Just-Buy-It", address: "noreply@intra-ai.de" },
    });

    const partial = Object.fromEntries(Object.entries(LOGIN_SMTP).filter(([name]) => name !== "LOGIN_FROM" && name !== "LOGIN_SMTP_PASSWORD"));
    const error = failure({ ...REQUIRED, ...partial });
    expect(error).toBeInstanceOf(EnvError);
    expect(error.message).toBe("invalid environment: LOGIN_SMTP is set partially, missing LOGIN_SMTP_PASSWORD, LOGIN_FROM");
  });

  it("names every missing or invalid variable and never a value", () => {
    const error = failure({
      ...REQUIRED,
      ...LOGIN_SMTP,
      AUTH_KEY: "c2hvcnQ=",
      PUBLIC_ORIGIN: "https://deals.intra-ai.de/login",
      DATABASE_URL: `mysql://web:${LOGIN_SMTP_PASSWORD}@db/x`,
      GIT_SHA: undefined,
    });

    expect(error).toBeInstanceOf(EnvError);
    expect(error.message).toBe("invalid environment: DATABASE_URL, GIT_SHA, AUTH_KEY, PUBLIC_ORIGIN");
    expect(error.message).not.toContain("SENTINEL");
    expect(error.message).not.toContain("c2hvcnQ");
  });
});
