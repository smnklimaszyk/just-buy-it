import { describe, expect, it } from "vitest";
import { createItemKey } from "./item-key.js";

// 32 bytes of 0x01, base64. The expected key was computed with
// `printf 900000000001 | openssl dgst -sha256 -mac HMAC -macopt hexkey:0101...01`.
const KEY_ONES = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

describe("createItemKey (ADR 0013, section 7.1)", () => {
  it("is HMAC-SHA256 of the legacy item ID under ITEM_KEY_V1, as lowercase hex, key version 1", () => {
    const itemKey = createItemKey(KEY_ONES);

    expect(itemKey("900000000001")).toEqual({
      itemKey: "48e20679aad0e0d2942f7a8877b3ac52ca06dc7b1268f32c9519ab8cdfeeeb63",
      keyVersion: 1,
    });
  });

  it("gives another key for another ID or another secret, and never carries the ID", () => {
    const ones = createItemKey(KEY_ONES);
    const twos = createItemKey(Buffer.alloc(32, 2).toString("base64"));

    expect(ones("900000000002").itemKey).not.toBe(ones("900000000001").itemKey);
    expect(twos("900000000001").itemKey).not.toBe(ones("900000000001").itemKey);
    expect(ones("900000000001").itemKey).not.toContain("900000000001");
  });

  it("refuses a secret that is not 32 bytes of base64, without echoing it", () => {
    const short = Buffer.alloc(16, 7).toString("base64");

    expect(() => createItemKey(short)).toThrow(new Error("ITEM_KEY_V1 must be 32 bytes in base64"));
    expect(() => createItemKey("not base64 at all!")).toThrow(new Error("ITEM_KEY_V1 must be 32 bytes in base64"));
  });
});
