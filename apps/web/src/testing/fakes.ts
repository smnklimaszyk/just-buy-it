import type { Clock } from "@ebay-sniper/domain";
import type { CreateTransportFn, MailTransport } from "@ebay-sniper/notify";

// Test helpers, not built: a clock moved by hand, a log that keeps every line, and a fake SMTP
// server the real mailer sends to.

export type TestClock = Clock & { set(at: Date): void; advance(ms: number): void };

export function createTestClock(start: Date): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set(at) {
      current = at.getTime();
    },
    advance(ms) {
      current += ms;
    },
  };
}

export type LogEntry = Record<string, unknown>;

export function createTestLog() {
  const lines: { level: "info" | "warn" | "error"; entry: LogEntry }[] = [];
  const at = (level: "info" | "warn" | "error") => (entry: LogEntry) => {
    lines.push({ level, entry });
  };
  return {
    log: { info: at("info"), warn: at("warn"), error: at("error") },
    lines,
    events(event: string): LogEntry[] {
      return lines.filter((line) => line.entry["event"] === event).map((line) => line.entry);
    },
    // Everything logged, as one string, for checks that a value never reaches the log.
    text(): string {
      return JSON.stringify(lines);
    },
  };
}

// Not a real password; the sentinel test looks for it, and for its AUTH PLAIN form, in the logs.
export const LOGIN_SMTP_TEST_PASSWORD = "login-smtp-test-SENTINEL-PASS-6a2f";

type SentMail = Parameters<MailTransport["sendMail"]>[0];

// "accept" answers 250; "hang" never answers; "auth" is a 535 whose error carries the AUTH
// exchange, as nodemailer's does.
export type SmtpReply = "accept" | "hang" | "auth" | number;

export function createFakeSmtp() {
  const sent: SentMail[] = [];
  const replies: SmtpReply[] = [];
  const createTransport: CreateTransportFn = (options) => {
    const auth = options.auth;
    const user = auth !== undefined && "user" in auth && typeof auth.user === "string" ? auth.user : "";
    const password = auth !== undefined && "pass" in auth && typeof auth.pass === "string" ? auth.pass : "";
    return {
      async sendMail(message) {
        sent.push(message);
        const reply = replies.shift() ?? "accept";
        if (reply === "hang") return new Promise<never>(() => undefined);
        if (reply === "auth") {
          const plain = Buffer.from(`\0${user}\0${password}`).toString("base64");
          throw Object.assign(new Error(`Invalid login: 535 Authentication failed for ${plain}`), {
            code: "EAUTH",
            responseCode: 535,
            command: `AUTH PLAIN ${plain}`,
          });
        }
        if (typeof reply === "number") {
          throw Object.assign(new Error(`${reply} synthetic reply`), { code: "EENVELOPE", responseCode: reply });
        }
        return { messageId: `<fake-${sent.length}@smtp.test>`, response: "250 2.0.0 Ok: queued" };
      },
      close: () => undefined,
    };
  };
  return {
    createTransport,
    // Every message handed to the transport, failed ones included.
    sent,
    // The next sends get these replies, in order; after them, 250.
    reply(...next: SmtpReply[]) {
      replies.push(...next);
    },
  };
}
