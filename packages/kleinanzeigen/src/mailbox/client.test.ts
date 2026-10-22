import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { describe, expect, it } from "vitest";
import { createImapFlowClient, type ImapClientConfig } from "./client.js";

const CONFIG: ImapClientConfig = {
  host: "imap.example.invalid",
  port: 993,
  user: "mailbox@example.invalid",
  password: "not-a-real-password",
  maxMessageBytes: 1_048_576,
  connectTimeoutMs: 10_000,
  greetingTimeoutMs: 11_000,
  socketTimeoutMs: 30_000,
};

describe("createImapFlowClient", () => {
  it("builds imapflow with TLS, no logger, no idle and the configured limits", () => {
    const seen: ImapFlowOptions[] = [];
    // Constructing an ImapFlow opens no socket; only connect() would.
    class RecordingImapFlow extends ImapFlow {
      constructor(options: ImapFlowOptions) {
        super(options);
        seen.push(options);
      }
    }
    createImapFlowClient(CONFIG, RecordingImapFlow);
    expect(seen).toEqual([
      {
        host: "imap.example.invalid",
        port: 993,
        secure: true,
        auth: { user: "mailbox@example.invalid", pass: "not-a-real-password" },
        logger: false,
        emitLogs: false,
        disableAutoIdle: true,
        connectionTimeout: 10_000,
        greetingTimeout: 11_000,
        socketTimeout: 30_000,
        maxLiteralSize: 1_048_576 + 65_536,
      },
    ]);
  });

  it("listens for imapflow error events, which would otherwise crash the process", () => {
    const flows: ImapFlow[] = [];
    class KeptImapFlow extends ImapFlow {
      constructor(options: ImapFlowOptions) {
        super(options);
        flows.push(this);
      }
    }
    createImapFlowClient(CONFIG, KeptImapFlow);
    expect(() => flows[0]?.emit("error", new Error("socket closed"))).not.toThrow();
  });
});
