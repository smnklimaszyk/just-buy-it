import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { challengeResponse, parseSignatureHeader, verifySignature } from "./deletion.js";

const endpoint = "https://deals.intra-ai.de/ebay/account-deletion";
const token = "a".repeat(64);

describe("challengeResponse", () => {
  it("hashes challenge code, verification token and endpoint in that order with SHA-256 hex", () => {
    const expected = createHash("sha256").update(`abc123${token}${endpoint}`).digest("hex");

    expect(challengeResponse("abc123", token, endpoint)).toBe(expected);
  });
});

describe("parseSignatureHeader", () => {
  it("decodes the base64 JSON header into key id and signature", () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "ecdsa", kid: "key-1", signature: "c2ln", digest: "SHA1" }),
    ).toString("base64");

    expect(parseSignatureHeader(header)).toEqual({ kid: "key-1", signature: "c2ln" });
  });

  it.each(["..", "a/b", "x".repeat(129)])("rejects a key id that is not a plain token: %s", (kid) => {
    const header = Buffer.from(JSON.stringify({ kid, signature: "c2ln" })).toString("base64");

    expect(() => parseSignatureHeader(header)).toThrow();
  });
});

describe("verifySignature", () => {
  it("accepts an ECDSA SHA-1 signature over the JSON body with eBay's single-line PEM key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const body = { metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n-1" } };
    const signature = sign("sha1", Buffer.from(JSON.stringify(body)), privateKey).toString("base64");
    const singleLinePem = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");

    expect(verifySignature(body, signature, singleLinePem)).toBe(true);
  });

  it("accepts a key in standard multi-line PEM form", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const body = { notification: { notificationId: "n-1" } };
    const signature = sign("sha1", Buffer.from(JSON.stringify(body)), privateKey).toString("base64");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(verifySignature(body, signature, pem)).toBe(true);
  });

  it("rejects a body that was changed after signing", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const body = { notification: { notificationId: "n-1" } };
    const signature = sign("sha1", Buffer.from(JSON.stringify(body)), privateKey).toString("base64");
    const singleLinePem = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");

    expect(verifySignature({ notification: { notificationId: "n-2" } }, signature, singleLinePem)).toBe(false);
  });
});
