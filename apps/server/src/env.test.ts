import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, parseEnv } from "./env.js";

const valid = {
  PORT: "3000",
  EBAY_ENVIRONMENT: "production",
  EBAY_DELETION_ENDPOINT_URL: "https://deals.intra-ai.de/ebay/account-deletion",
  EBAY_DELETION_VERIFICATION_TOKEN: "a".repeat(64),
  EBAY_CLIENT_ID: "app-id",
  EBAY_CLIENT_SECRET: "cert-id",
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  DATABASE_URL: "postgres://app:apppass@postgres:5432/ebay_sniper",
  DELETION_PROBE_CODE: "Pr0be_code-0123456789abcdefghijABCDEFGHI",
};

describe("parseEnv", () => {
  it("reads a complete production environment", () => {
    expect(parseEnv(valid)).toEqual({
      port: 3000,
      ebayApiBase: "https://api.ebay.com",
      deletionEndpointUrl: "https://deals.intra-ai.de/ebay/account-deletion",
      deletionVerificationToken: "a".repeat(64),
      ebayClientId: "app-id",
      ebayClientSecret: "cert-id",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      databaseUrl: "postgres://app:apppass@postgres:5432/ebay_sniper",
      deletionProbeCode: "Pr0be_code-0123456789abcdefghijABCDEFGHI",
    });
  });

  it("starts without eBay client credentials so the challenge works before they exist", () => {
    const env = parseEnv({ ...valid, EBAY_CLIENT_ID: undefined, EBAY_CLIENT_SECRET: undefined });

    expect(env.ebayClientId).toBeUndefined();
    expect(env.ebayClientSecret).toBeUndefined();
  });

  it("reads empty eBay credentials as absent, as Compose passes them when unset", () => {
    const env = parseEnv({ ...valid, EBAY_CLIENT_ID: "", EBAY_CLIENT_SECRET: "" });

    expect(env.ebayClientId).toBeUndefined();
    expect(env.ebayClientSecret).toBeUndefined();
  });

  it("refuses a deletion endpoint that is not HTTPS", () => {
    expect(() => parseEnv({ ...valid, EBAY_DELETION_ENDPOINT_URL: "http://deals.intra-ai.de/ebay/account-deletion" })).toThrow();
  });

  it.each(["a".repeat(31), "a".repeat(81), `${"a".repeat(40)}!`])(
    "refuses a verification token eBay would reject: %s",
    (token) => {
      expect(() => parseEnv({ ...valid, EBAY_DELETION_VERIFICATION_TOKEN: token })).toThrow();
    },
  );

  it.each([undefined, "", "0123456", "0123456789ABCDEF0123456789ABCDEF01234567", `${"a".repeat(40)}0`])(
    "refuses a GIT_SHA that is not a full lowercase commit SHA: %s",
    (sha) => {
      expect(() => parseEnv({ ...valid, GIT_SHA: sha })).toThrow();
    },
  );
});

describe("parseEnv database and probe values", () => {
  it.each([undefined, "", "http://app:x@postgres:5432/ebay_sniper", "not a url"])(
    "refuses a DATABASE_URL that is missing or not postgres: %s",
    (url) => {
      expect(() => parseEnv({ ...valid, DATABASE_URL: url })).toThrow("invalid environment: DATABASE_URL");
    },
  );

  it.each([undefined, "", "a".repeat(39), "a".repeat(41), `${"a".repeat(39)}+`])(
    "refuses a DELETION_PROBE_CODE that is missing or not 40 URL-safe characters: %s",
    (code) => {
      expect(() => parseEnv({ ...valid, DELETION_PROBE_CODE: code })).toThrow("invalid environment: DELETION_PROBE_CODE");
    },
  );
});

describe("parseEnv without the MVP dashboard (spec 10.4)", () => {
  it("ignores DASHBOARD_PORT and DASHBOARD_DATABASE_URL left over from Release 0", () => {
    const leftover = { DASHBOARD_PORT: "abc", DASHBOARD_DATABASE_URL: "not a url" };

    expect(parseEnv({ ...valid, ...leftover })).toEqual(parseEnv(valid));
  });
});

describe("parseEnv errors", () => {
  it("names the failing variables and never their values", () => {
    const sentinel = "sentinel-token-value!";

    let message = "";
    try {
      parseEnv({ ...valid, EBAY_DELETION_VERIFICATION_TOKEN: sentinel, DATABASE_URL: `http://app:${sentinel}@db/x` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("invalid environment: EBAY_DELETION_VERIFICATION_TOKEN, DATABASE_URL");
  });
});

describe("loadEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the process environment", () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);

    expect(loadEnv().gitSha).toBe(valid.GIT_SHA);
  });
});
