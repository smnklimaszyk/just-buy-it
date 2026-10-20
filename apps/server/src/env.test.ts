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
    });
  });

  it("starts without eBay client credentials so the challenge works before they exist", () => {
    const env = parseEnv({ ...valid, EBAY_CLIENT_ID: undefined, EBAY_CLIENT_SECRET: undefined });

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

describe("loadEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the process environment", () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);

    expect(loadEnv().gitSha).toBe(valid.GIT_SHA);
  });
});
