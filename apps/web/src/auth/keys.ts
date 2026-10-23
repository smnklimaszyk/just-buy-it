import { createHmac, hkdfSync } from "node:crypto";

// Spec 7.3: AUTH_KEY never leaves web and ops. Each use gets its own subkey from HKDF-SHA-256 with
// an empty salt and the label as info, the same derivation as apps/ops/src/auth-command.ts.
// "login-form" is the one label beyond spec 7.3's four: the sign-in forms' token, tied to the
// login cookie.
type Label = "code" | "email" | "ip" | "device" | "login-form";

const subkey = (authKey: Buffer, label: Label): Buffer => Buffer.from(hkdfSync("sha256", authKey, Buffer.alloc(0), label, 32));

export type AuthKeys = {
  // Of the normalized address: strangers' addresses are stored only as this.
  emailMac(email: string): string;
  // HMAC(K_code, attempt_id || code), the attempt's code_mac.
  codeMac(attemptId: string, code: string): string;
  // The rate-limit subject of an IP.
  ipMac(ip: string): string;
  // auth.device.token_hash of a device cookie.
  deviceHash(deviceToken: string): string;
  // The hidden token of the sign-in forms: only the browser holding the login cookie can send it.
  loginFormToken(loginCookie: string): string;
};

export function createAuthKeys(authKey: Buffer): AuthKeys {
  const mac = (label: Label) => {
    const key = subkey(authKey, label);
    return (value: string) => createHmac("sha256", key).update(value).digest("hex");
  };
  const code = mac("code");
  return {
    emailMac: mac("email"),
    codeMac: (attemptId, value) => code(`${attemptId}${value}`),
    ipMac: mac("ip"),
    deviceHash: mac("device"),
    loginFormToken: mac("login-form"),
  };
}
