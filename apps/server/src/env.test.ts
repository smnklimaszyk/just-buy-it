import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const valid = {
  PORT: "3000",
  EBAY_ENVIRONMENT: "production",
  EBAY_DELETION_ENDPOINT_URL: "https://deals.intra-ai.de/ebay/account-deletion",
  EBAY_DELETION_VERIFICATION_TOKEN: "a".repeat(64),
  EBAY_CLIENT_ID: "app-id",
  EBAY_CLIENT_SECRET: "cert-id",
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
});
