import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { challengeResponse, parseSignatureHeader, verifySignature } from "./deletion.js";

const endpoint = "https://deals.intra-ai.de/ebay/account-deletion";
const token = "a".repeat(64);

describe("test setup", () => {
  it("makes the global fetch throw, so every request has to go through an injected fetchFn", () => {
    expect(() => fetch("https://api.ebay.com/")).toThrow(/injected fetchFn/);
  });
});

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

    expect(parseSignatureHeader(header)).toEqual({ ok: true, kid: "key-1", signature: "c2ln" });
  });

  it.each(["..", "x".repeat(129)])("counts a key id outside the ADR 0013 rule as malformed: %s", (kid) => {
    const header = Buffer.from(JSON.stringify({ alg: "ecdsa", kid, signature: "c2ln", digest: "SHA1" })).toString(
      "base64",
    );

    expect(parseSignatureHeader(header)).toEqual({ ok: false, result: "malformed" });
  });
});

describe("parseSignatureHeader results", () => {
  const header = (fields: Record<string, unknown>) =>
    Buffer.from(JSON.stringify({ alg: "ecdsa", kid: "key-1", signature: "c2ln", digest: "SHA1", ...fields })).toString(
      "base64",
    );

  it.each([
    ["not base64 JSON", Buffer.from("{not json").toString("base64")],
    ["bad base64", "%%%***"],
    ["a JSON string", Buffer.from('"ecdsa"').toString("base64")],
    ["no alg", header({ alg: undefined })],
    ["no kid", header({ kid: undefined })],
    ["no signature", header({ signature: undefined })],
    ["no digest", header({ digest: undefined })],
    ["an empty key id", header({ kid: "" })],
    ["a key id with a byte above 0x7E", header({ kid: "key-é" })],
    ["a key id with DEL", header({ kid: "key\u007f" })],
    ["a key id with a tab", header({ kid: "key\t1" })],
    ["a key id of .", header({ kid: "." })],
  ])("counts %s as malformed", (_name, value) => {
    expect(parseSignatureHeader(value)).toEqual({ ok: false, result: "malformed" });
  });

  it("accepts a key id of 128 printable characters including slash, percent and space", () => {
    const kid = `a/b%2F c..${"x".repeat(118)}`;

    expect(kid).toHaveLength(128);
    expect(parseSignatureHeader(header({ kid }))).toEqual({ ok: true, kid, signature: "c2ln" });
  });

  it("counts an algorithm other than ecdsa as unsupported_alg", () => {
    const header = Buffer.from(JSON.stringify({ alg: "rsa", kid: "key-1", signature: "c2ln", digest: "SHA1" })).toString(
      "base64",
    );

    expect(parseSignatureHeader(header)).toEqual({ ok: false, result: "unsupported_alg" });
  });

  it.each([
    ["a digest other than SHA1", { digest: "SHA256" }, { ok: false, result: "unsupported_alg" }],
    ["alg and digest in other letter case", { alg: "ECDSA", digest: "sha1" }, { ok: true, kid: "key-1", signature: "c2ln" }],
  ])("checks %s", (_name, fields, expected) => {
    expect(parseSignatureHeader(header(fields))).toEqual(expected);
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
