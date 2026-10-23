import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newCode, newToken, sameSecret, tokenHash } from "./tokens.js";

describe("tokens and codes", () => {
  it("makes 32-byte base64url tokens stored as SHA-256 and 8-digit codes", () => {
    const tokens = new Set(Array.from({ length: 200 }, newToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
    expect(tokenHash("abc")).toBe(createHash("sha256").update("abc").digest("hex"));

    const codes = Array.from({ length: 500 }, newCode);
    for (const code of codes) expect(code).toMatch(/^\d{8}$/);
    // Zero-padded: about 10 % of 8-digit codes start with 0.
    expect(codes.some((code) => code.startsWith("0"))).toBe(true);
  });

  it("compares secrets in constant time, also when the lengths differ", () => {
    const calls: number[] = [];
    const compare = (a: Buffer, b: Buffer) => {
      calls.push(a.length, b.length);
      return a.equals(b);
    };

    expect(sameSecret("a1b2", "a1b2", compare)).toBe(true);
    expect(sameSecret("a1b2", "a1b3", compare)).toBe(false);
    expect(sameSecret("a1b2", "a1b2c3d4", compare)).toBe(false);
    expect(sameSecret("", "a1b2", compare)).toBe(false);
    // Always two 32-byte digests, so neither the content nor the length decides how long it takes.
    expect(new Set(calls)).toEqual(new Set([32]));
    expect(sameSecret("x", "x")).toBe(true);
  });
});
