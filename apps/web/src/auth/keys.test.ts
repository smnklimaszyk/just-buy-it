import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAuthKeys } from "./keys.js";

const AUTH_KEY = Buffer.alloc(32, 3);

// What `ops auth code` and `ops auth unlock` compute (apps/ops/src/auth-command.ts): the HMACs
// have to match, or the CLI finds no attempt and unlocks nothing.
const opsMac = (label: string, value: string) =>
  createHmac("sha256", Buffer.from(hkdfSync("sha256", AUTH_KEY, Buffer.alloc(0), label, 32))).update(value).digest("hex");

describe("createAuthKeys", () => {
  it("derives the email and code HMACs exactly as the ops CLI does", () => {
    const keys = createAuthKeys(AUTH_KEY);

    expect(keys.emailMac("info@intra-ai.de")).toBe(opsMac("email", "info@intra-ai.de"));
    expect(keys.codeMac("0199f0c2-0000-7000-8000-000000000001", "48210937")).toBe(
      opsMac("code", "0199f0c2-0000-7000-8000-00000000000148210937"),
    );
  });

  it("gives IPs, device tokens and login form tokens their own subkeys", () => {
    const keys = createAuthKeys(AUTH_KEY);
    const value = "198.51.100.7";

    expect(keys.ipMac(value)).toBe(opsMac("ip", value));
    expect(keys.deviceHash(value)).toBe(opsMac("device", value));
    expect(keys.loginFormToken(value)).toBe(opsMac("login-form", value));
    expect(new Set([keys.emailMac(value), keys.ipMac(value), keys.deviceHash(value), keys.loginFormToken(value)]).size).toBe(4);
  });
});
