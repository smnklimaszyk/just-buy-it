import { createHmac } from "node:crypto";

// ADR 0013: the item key is HMAC-SHA256 under ITEM_KEY_V1 over the legacy item ID, as hex. The
// domain package has no crypto, so the key is made here.
export const ITEM_KEY_VERSION = 1;

export type ItemKey = { itemKey: string; keyVersion: typeof ITEM_KEY_VERSION };

export type ItemKeyFn = (legacyItemId: string) => ItemKey;

const SECRET_BYTES = 32;

export function createItemKey(secretBase64: string): ItemKeyFn {
  const secret = Buffer.from(secretBase64, "base64");
  // Buffer.from skips characters that are not base64, so the round trip checks the text. The
  // message never carries the value.
  if (secret.length !== SECRET_BYTES || secret.toString("base64") !== secretBase64) {
    throw new Error("ITEM_KEY_V1 must be 32 bytes in base64");
  }
  return (legacyItemId) => ({
    itemKey: createHmac("sha256", secret).update(legacyItemId).digest("hex"),
    keyVersion: ITEM_KEY_VERSION,
  });
}
