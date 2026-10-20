import { createHash, verify } from "node:crypto";
import { z } from "zod";

const PEM_START = "-----BEGIN PUBLIC KEY-----";
const PEM_END = "-----END PUBLIC KEY-----";

// The kid ends up in an eBay API path, so only plain tokens are accepted.
const signatureHeaderSchema = z.object({
  kid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  signature: z.string().min(1).max(512),
});

export type SignatureHeader = z.infer<typeof signatureHeaderSchema>;

export function parseSignatureHeader(header: string): SignatureHeader {
  const { kid, signature } = signatureHeaderSchema.parse(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
  return { kid, signature };
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
