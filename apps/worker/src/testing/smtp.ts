import type { CreateTransportFn, MailTransport, TransportOptions } from "@ebay-sniper/notify";

// A fake SMTP server for the worker tests: the real mailer runs on this transport. Failures are
// shaped like nodemailer's errors, whose fields can carry the AUTH exchange.

// Not a real password; the sentinel tests look for it, and for its AUTH PLAIN form, in logs and errors.
export const SMTP_TEST_PASSWORD = "smtp-test-SENTINEL-PASS-51d0";

type SentMail = Parameters<MailTransport["sendMail"]>[0];

// "accept" answers 250; a number answers that SMTP reply code; "auth" is a 535 login failure;
// "timeout" and "refused" fail the connection; "hang" never answers.
export type SmtpReply = "accept" | number | "auth" | "timeout" | "refused" | "hang";

function nodemailerError(fields: { message: string; code: string; responseCode?: number; response?: string; command?: string }): Error {
  return Object.assign(new Error(fields.message), fields);
}

function failure(reply: Exclude<SmtpReply, "accept" | "hang">, user: string, password: string): Error {
  const authPlain = Buffer.from(`\0${user}\0${password}`).toString("base64");
  if (reply === "auth") {
    return nodemailerError({
      message: `Invalid login: 535 5.7.8 Authentication failed for ${authPlain}`,
      code: "EAUTH",
      responseCode: 535,
      response: "535 5.7.8 Authentication failed",
      command: `AUTH PLAIN ${authPlain}`,
    });
  }
  if (reply === "timeout") return nodemailerError({ message: "Connection timeout", code: "ETIMEDOUT", command: "CONN" });
  if (reply === "refused") return nodemailerError({ message: "connect ECONNREFUSED", code: "ECONNECTION", command: "CONN" });
  return nodemailerError({
    message: `Can't send mail - all recipients were rejected: ${reply} reply`,
    code: "EENVELOPE",
    responseCode: reply,
    response: `${reply} synthetic reply`,
    command: "RCPT TO",
  });
}

export function createFakeSmtp() {
  const sent: SentMail[] = [];
  const transportOptions: TransportOptions[] = [];
  const replies: SmtpReply[] = [];
  let accepted = 0;

  const createTransport: CreateTransportFn = (options) => {
    transportOptions.push(options);
    const auth = options.auth;
    const user = auth !== undefined && "user" in auth && typeof auth.user === "string" ? auth.user : "";
    const password = auth !== undefined && "pass" in auth && typeof auth.pass === "string" ? auth.pass : "";
    return {
      async sendMail(message) {
        sent.push(message);
        const reply = replies.shift() ?? "accept";
        if (reply === "hang") return new Promise<never>(() => undefined);
        if (reply !== "accept") throw failure(reply, user, password);
        accepted += 1;
        return { messageId: `<fake-${accepted}@smtp.test>`, response: "250 2.0.0 Ok: queued" };
      },
      close: () => undefined,
    };
  };

  return {
    createTransport,
    // Every message handed to the transport, failed ones included.
    sent,
    transportOptions,
    // The next sends get these replies, in order; after them, 250.
    reply(...next: SmtpReply[]) {
      replies.push(...next);
    },
  };
}
