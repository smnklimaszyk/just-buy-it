// ALERT_FROM could not be read as one sender. The message names the variable and the problem,
// never the value.
export class SenderError extends Error {
  constructor(problem: string) {
    super(`ALERT_FROM ${problem}`);
    this.name = "SenderError";
  }
}

// What the send job does with a failed send (section 6.5): transient goes back to pending with
// a backoff; failed is final; auth keeps the delivery pending and pauses all sends 15 minutes.
export type SmtpErrorKind = "transient" | "failed" | "auth";

export type SmtpErrorFields = { code: string; responseCode: number | null };

function kindOf({ code, responseCode }: SmtpErrorFields): SmtpErrorKind {
  if (code === "EAUTH" || responseCode === 535) return "auth";
  if (responseCode !== null && responseCode >= 500) return "failed";
  return "transient";
}

export class SmtpError extends Error {
  readonly code: string;
  readonly responseCode: number | null;
  readonly kind: SmtpErrorKind;

  constructor(fields: SmtpErrorFields) {
    super(`SMTP send failed: ${fields.code}`);
    this.name = "SmtpError";
    this.code = fields.code;
    this.responseCode = fields.responseCode;
    this.kind = kindOf(fields);
  }
}

// nodemailer's SMTP error codes and the Node.js socket codes that can reach the adapter. Any
// other value becomes "unknown", so last_error_code holds only names from this list.
const KNOWN_CODES: ReadonlySet<string> = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ETLS",
  "EREQUIRETLS",
  "EPROTOCOL",
  "EENVELOPE",
  "EMESSAGE",
  "ESTREAM",
  "EAUTH",
  "ENOAUTH",
  "EMAXLIMIT",
  "EMAXRECIPIENTS",
  "ECONFIG",
  "EPROXY",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

const fieldOf =(error: unknown, key: string): unknown =>
  typeof error === "object" && error !== null ? (error as Record<string, unknown>)[key] : undefined;

// Maps whatever nodemailer rejected with to an SmtpError.
export function toSmtpError(error: unknown): SmtpError {
  const code = fieldOf(error, "code");
  const responseCode = fieldOf(error, "responseCode");
  return new SmtpError({
    code: typeof code === "string" && KNOWN_CODES.has(code) ? code : "unknown",
    responseCode: typeof responseCode === "number" ? responseCode : null,
  });
}
