import { createTransport, type SMTPTransportOptions, type SendMailOptions } from "nodemailer";
import { SmtpError, toSmtpError } from "./errors.js";
import type { Sender } from "./sender.js";

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  // ALERT_FROM as parseSender() returns it.
  from: Sender;
};

export type TransportOptions = SMTPTransportOptions;

// The part of a nodemailer transporter the adapter uses; tests pass a fake.
export type MailTransport = {
  sendMail(options: SendMailOptions): Promise<{ messageId: string; response: string }>;
  close(): void;
};

export type CreateTransportFn = (options: TransportOptions) => MailTransport;

// One message per delivery. `to` is the delivery's recipient (ALERT_TO).
export type OutgoingEmail = {
  deliveryId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SmtpSendResult = {
  messageId: string;
  // The code of the server's final reply, 250 for an accepted message.
  responseCode: number | null;
};

export type SmtpMailer = {
  // `signal` is the send job's deadline. nodemailer cannot cancel a send, so the job stops
  // waiting; a server that still accepts the message later can cause one duplicate.
  send(email: OutgoingEmail, signal?: AbortSignal): Promise<SmtpSendResult>;
  close(): void;
};

const deadlineError = (): SmtpError => new SmtpError({ code: "deadline", responseCode: null });

function deadline(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(deadlineError()), { once: true });
  });
}

const REPLY_CODE = /^(\d{3})/;

function replyCode(response: string): number | null {
  const match = REPLY_CODE.exec(response);
  return match === null ? null : Number(match[1]);
}

function nodemailerTransport(options: TransportOptions): MailTransport {
  const transporter = createTransport(options);
  return {
    sendMail: (message) => transporter.sendMail(message),
    close: () => transporter.close(),
  };
}

// Section 6.5. Port 465 is TLS from the first byte; any other port must upgrade with STARTTLS, so
// the password never crosses the network in clear text. One connection per message (no pool).
function transportOptions(config: SmtpConfig): TransportOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: false,
  };
}

export function createSmtpMailer(config: SmtpConfig, createTransportFn: CreateTransportFn = nodemailerTransport): SmtpMailer {
  const transport = createTransportFn(transportOptions(config));
  return {
    async send(email, signal) {
      if (signal?.aborted === true) throw deadlineError();
      const sending = transport
        .sendMail({
          // The parsed object, so nodemailer encodes the display name (section 6.5).
          from: { name: config.from.name, address: config.from.address },
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: { "X-Delivery-Id": email.deliveryId },
        })
        .catch((error: unknown) => {
          throw toSmtpError(error);
        });
      const info = signal === undefined ? await sending : await Promise.race([sending, deadline(signal)]);
      return { messageId: info.messageId, responseCode: replyCode(info.response) };
    },
    close: () => transport.close(),
  };
}
