import { createHash, verify } from "node:crypto";
import { z } from "zod";

const PEM_START = "-----BEGIN PUBLIC KEY-----";
const PEM_END = "-----END PUBLIC KEY-----";

// ADR 0013: a key id is 1 to 128 printable ASCII characters. The key client puts it into the URL
// path with encodeURIComponent, which leaves "." and ".." alone, and fetch would resolve those to
// another eBay path, so they are refused too.
const signatureHeaderSchema = z.object({
  alg: z.string().max(32),
  kid: z
    .string()
    .regex(/^[\x20-\x7E]{1,128}$/)
    .refine((kid) => kid !== "." && kid !== ".."),
  signature: z.string().min(1).max(512),
  digest: z.string().max(32),
});

export type SignatureHeader =
  | { ok: true; kid: string; signature: string }
  | { ok: false; result: "malformed" | "unsupported_alg" };

export function parseSignatureHeader(header: string): SignatureHeader {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, result: "malformed" };
  }
  const parsed = signatureHeaderSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, result: "malformed" };
  const { alg, kid, signature, digest } = parsed.data;
  if (alg.toLowerCase() !== "ecdsa" || digest.toUpperCase() !== "SHA1") return { ok: false, result: "unsupported_alg" };
  return { ok: true, kid, signature };
}

export function challengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return createHash("sha256").update(challengeCode).update(verificationToken).update(endpoint).digest("hex");
}

// eBay's Notification API returns the PEM on one line; Node needs the header and footer on their own lines.
function toPem(key: string): string {
  return key.replace(/\r?\n/g, "").replace(PEM_START, `${PEM_START}\n`).replace(PEM_END, `\n${PEM_END}`);
}

// eBay signs JSON.stringify of the parsed body with ECDSA over SHA-1 (as in eBay's own Node SDK).
export function verifySignature(body: unknown, signatureBase64: string, publicKey: string): boolean {
  return verify("sha1", Buffer.from(JSON.stringify(body)), toPem(publicKey), Buffer.from(signatureBase64, "base64"));
}
