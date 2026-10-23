import { describe, expect, it } from "vitest";
import type { SendMailOptions } from "nodemailer";
import { SmtpError } from "./errors.js";
import {
  createSmtpMailer,
  type MailTransport,
  type OutgoingEmail,
  type SmtpConfig,
  type TransportOptions,
} from "./smtp.js";

const config: SmtpConfig = {
  host: "mail.example.test",
  port: 587,
  user: "alerts@example.test",
  password: "test-password",
  from: { name: "Just-Buy-It", address: "alerts@example.test" },
};

const email: OutgoingEmail = {
  deliveryId: "0199f0a0-0000-7000-8000-000000000001",
  to: "owner@example.test",
  subject: "[Deal] RTX 3090: EUR 489 incl. shipping (94% of max) - PASS",
  text: "plain body",
  html: "<p>html body</p>",
};

// An error shaped like the ones nodemailer rejects with: an Error with extra fields.
function nodemailerError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

type FakeTransport = MailTransport & { options: TransportOptions | null };

function fakeTransport(): FakeTransport {
  const transport: FakeTransport = {
    options: null,
    sendMail: () => Promise.resolve({ messageId: "<m1@example.test>", response: "250 2.0.0 OK" }),
    close: () => undefined,
  };
  return transport;
}

function mailerWith(transport: FakeTransport, smtp: SmtpConfig = config) {
  return createSmtpMailer(smtp, (options) => {
    transport.options = options;
    return transport;
  });
}

describe("createSmtpMailer", () => {
  it("builds a STARTTLS transport on port 587 with the section 6.5 timeouts and no pool", () => {
    const transport = fakeTransport();
    mailerWith(transport);
    expect(transport.options).toEqual({
      host: "mail.example.test",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "alerts@example.test", pass: "test-password" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      pool: false,
    });
  });

  it("uses implicit TLS on port 465", () => {
    const transport = fakeTransport();
    mailerWith(transport, { ...config, port: 465 });
    expect(transport.options).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  it("sends an accepted message and returns the message ID and the 250 code", async () => {
    const transport = fakeTransport();
    const sent: SendMailOptions[] = [];
    transport.sendMail = (options) => {
      sent.push(options);
      return Promise.resolve({ messageId: "<m1@example.test>", response: "250 2.0.0 OK queued as 1234" });
    };
    const result = await mailerWith(transport).send(email);
    expect(result).toEqual({ messageId: "<m1@example.test>", responseCode: 250 });
    expect(sent).toEqual([
      {
        from: { name: "Just-Buy-It", address: "alerts@example.test" },
        to: "owner@example.test",
        subject: "[Deal] RTX 3090: EUR 489 incl. shipping (94% of max) - PASS",
        text: "plain body",
        html: "<p>html body</p>",
        headers: { "X-Delivery-Id": "0199f0a0-0000-7000-8000-000000000001" },
      },
    ]);
  });

  it("sends the product's people in Bcc, so no recipient sees another's address, and leaves To as it is", async () => {
    const transport = fakeTransport();
    const sent: SendMailOptions[] = [];
    transport.sendMail = (options) => {
      sent.push(options);
      return Promise.resolve({ messageId: "<m2@example.test>", response: "250 2.0.0 OK" });
    };
    await mailerWith(transport).send({ ...email, bcc: ["anna@example.test", "ben@example.test"] });
    expect(sent).toEqual([
      expect.objectContaining({ to: "owner@example.test", bcc: ["anna@example.test", "ben@example.test"] }),
    ]);
    expect(JSON.stringify(sent[0]?.headers)).not.toContain("anna@example.test");
  });

  it("sets no Bcc field when the product has no one but ALERT_TO", async () => {
    const transport = fakeTransport();
    const sent: SendMailOptions[] = [];
    transport.sendMail = (options) => {
      sent.push(options);
      return Promise.resolve({ messageId: "<m3@example.test>", response: "250 2.0.0 OK" });
    };
    await mailerWith(transport).send({ ...email, bcc: [] });
    expect(sent[0]).not.toHaveProperty("bcc");
  });

  it("maps a 421 reply to a transient SmtpError", async () => {
    const transport = fakeTransport();
    transport.sendMail = () =>
      Promise.reject(nodemailerError("Service not available", { code: "EENVELOPE", responseCode: 421 }));
    const sending = mailerWith(transport).send(email);
    await expect(sending).rejects.toBeInstanceOf(SmtpError);
    await expect(sending).rejects.toMatchObject({ code: "EENVELOPE", responseCode: 421, kind: "transient" });
  });

  it("maps a 550 recipient refusal to a failed SmtpError", async () => {
    const transport = fakeTransport();
    transport.sendMail = () =>
      Promise.reject(nodemailerError("Recipient refused", { code: "EENVELOPE", responseCode: 550 }));
    await expect(mailerWith(transport).send(email)).rejects.toMatchObject({
      code: "EENVELOPE",
      responseCode: 550,
      kind: "failed",
    });
  });

  it("maps EAUTH (535) to the auth kind that pauses all sends", async () => {
    const transport = fakeTransport();
    transport.sendMail = () =>
      Promise.reject(nodemailerError("Invalid login", { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }));
    await expect(mailerWith(transport).send(email)).rejects.toMatchObject({
      code: "EAUTH",
      responseCode: 535,
      kind: "auth",
    });
  });

  it("drops the AUTH exchange: no form of the password survives in the mapped error", async () => {
    const password = "SENTINEL_SMTP_PASSWORD_9c41";
    const authPlain = Buffer.from(`\u0000${config.user}\u0000${password}`).toString("base64");
    const transport = fakeTransport();
    transport.sendMail = () =>
      Promise.reject(
        nodemailerError(`Invalid login: 535 5.7.8 rejected AUTH PLAIN ${authPlain} for ${password}`, {
          code: "EAUTH",
          responseCode: 535,
          command: `AUTH PLAIN ${authPlain}`,
          response: `535 5.7.8 Authentication failed for ${password}`,
        }),
      );
    const error = await mailerWith(transport, { ...config, password })
      .send(email)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmtpError);
    const smtpError = error as SmtpError;
    const forms = [
      smtpError.message,
      smtpError.stack ?? "",
      String(smtpError),
      String(smtpError.cause),
      JSON.stringify(smtpError),
      JSON.stringify(Object.getOwnPropertyNames(smtpError).map((key) => [key, String(Reflect.get(smtpError, key))])),
    ];
    for (const form of forms) {
      expect(form).not.toContain(password);
      expect(form).not.toContain(authPlain);
      expect(form).not.toContain("AUTH PLAIN");
    }
    expect(smtpError.cause).toBeUndefined();
  });

  it("maps a refused connection, a timeout and a TLS failure to transient", async () => {
    for (const code of ["ESOCKET", "ECONNREFUSED", "ETIMEDOUT", "ETLS", "ECONNECTION"]) {
      const transport = fakeTransport();
      transport.sendMail = () => Promise.reject(nodemailerError("connection problem", { code }));
      await expect(mailerWith(transport).send(email)).rejects.toMatchObject({ code, responseCode: null, kind: "transient" });
    }
  });

  it("stops at the handler deadline while the server does not answer", async () => {
    const transport = fakeTransport();
    transport.sendMail = () => new Promise(() => undefined);
    const deadline = new AbortController();
    const sending = mailerWith(transport).send(email, deadline.signal);
    deadline.abort();
    await expect(sending).rejects.toMatchObject({ code: "deadline", responseCode: null, kind: "transient" });
  });

  it("does not start a send once the deadline has passed", async () => {
    const transport = fakeTransport();
    let calls = 0;
    transport.sendMail = () => {
      calls += 1;
      return new Promise(() => undefined);
    };
    const sending = mailerWith(transport).send(email, AbortSignal.abort());
    await expect(sending).rejects.toMatchObject({ code: "deadline", kind: "transient" });
    expect(calls).toBe(0);
  });

  it("keeps only known error codes, so a code field can never carry text into last_error_code", async () => {
    const transport = fakeTransport();
    transport.sendMail = () => Promise.reject(nodemailerError("odd", { code: "SENTINEL_SMTP_PASSWORD_9c41" }));
    await expect(mailerWith(transport).send(email)).rejects.toMatchObject({
      code: "unknown",
      responseCode: null,
      kind: "transient",
    });
  });
});
