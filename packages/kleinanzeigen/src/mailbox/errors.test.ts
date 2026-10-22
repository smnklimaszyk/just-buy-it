import { describe, expect, it } from "vitest";
import { MailboxError, toMailboxError } from "./errors.js";

describe("toMailboxError", () => {
  it("maps an imapflow login refusal to auth_failed with a fixed message", () => {
    const err = toMailboxError(
      Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        responseText: "NO [AUTHENTICATIONFAILED] bad password",
      }),
    );
    expect(err).toBeInstanceOf(MailboxError);
    expect(err.kind).toBe("auth_failed");
    expect(err.message).toBe("Kleinanzeigen mailbox: auth_failed");
  });

  it("maps an imapflow TLS failure without a code to connection_failed", () => {
    const err = toMailboxError(Object.assign(new Error("TLS said something"), { tlsFailed: true }));
    expect(err.kind).toBe("connection_failed");
    expect(err.code).toBeUndefined();
  });

  it("maps the other certificate, TLS and network failures of a direct TLS connect to connection_failed", () => {
    const codes = [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "EPROTO",
      "ENETUNREACH",
      "EPIPE",
      "ECONNABORTED",
    ];
    for (const code of codes) {
      const err = toMailboxError(Object.assign(new Error("socket said something"), { code }));
      expect([err.kind, err.code], code).toEqual(["connection_failed", code]);
    }
  });

  it("maps a TLS failure with an unlisted code to connection_failed and drops the code", () => {
    const err = toMailboxError(Object.assign(new Error("TLS said something"), { tlsFailed: true, code: "ALERT" }));
    expect(err.kind).toBe("connection_failed");
    expect(err.code).toBeUndefined();
  });

  it.each([
    ["NO [ALERT] password hunter2 rejected"],
    ["CERT_ password hunter2"],
    [`ERR_TLS_${"X".repeat(100)}`],
    [42],
  ])("copies no code that is off the allowlist or not a plain code (%j)", (code) => {
    const err = toMailboxError(Object.assign(new Error("server text hunter2"), { code }));
    expect(err.kind).toBe("protocol");
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("Kleinanzeigen mailbox: protocol");
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain("hunter2");
  });

  it.each([
    ["CONNECT_TIMEOUT", "timeout"],
    ["GREETING_TIMEOUT", "timeout"],
    ["UPGRADE_TIMEOUT", "timeout"],
    ["ETIMEOUT", "timeout"],
    ["ETIMEDOUT", "timeout"],
    ["NoConnection", "connection_failed"],
    ["EConnectionClosed", "connection_failed"],
    ["ClosedAfterConnectText", "connection_failed"],
    ["ClosedAfterConnectTLS", "connection_failed"],
    ["ECONNREFUSED", "connection_failed"],
    ["ECONNRESET", "connection_failed"],
    ["ENOTFOUND", "connection_failed"],
    ["EAI_AGAIN", "connection_failed"],
    ["EHOSTUNREACH", "connection_failed"],
    ["CERT_HAS_EXPIRED", "connection_failed"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "connection_failed"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "connection_failed"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "connection_failed"],
    ["InvalidResponse", "protocol"],
  ])("maps code %s to %s and keeps the code", (code, kind) => {
    const err = toMailboxError(Object.assign(new Error("socket said something"), { code }));
    expect(err.kind).toBe(kind);
    expect(err.code).toBe(code);
  });
});
