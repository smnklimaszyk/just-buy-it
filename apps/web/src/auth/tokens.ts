import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

// CSRF tokens, form tokens and code HMACs (spec 7.3, 7.6). Both sides are hashed first, so the
// compare always sees two 32-byte buffers and the time it takes says nothing about the length.
export function sameSecret(
  a: string,
  b: string,
  compare: (x: Buffer, y: Buffer) => boolean = timingSafeEqual,
): boolean {
  return compare(digest(a), digest(b));
}

// Session, device and login cookies: 32 random bytes, base64url (spec 7.2, 7.4, 7.5).
export const newToken = (): string => randomBytes(32).toString("base64url");

// What the database keeps of a session or login cookie. A plain hash is enough at 256 bits.
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

// Spec 7.3: 8 digits from the CSPRNG, zero-padded.
export const newCode = (): string => String(randomInt(100_000_000)).padStart(8, "0");
