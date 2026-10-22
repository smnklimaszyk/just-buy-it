import pino, { type Logger, type LoggerOptions } from "pino";

const SECRET_HEADERS = [".authorization", ".cookie", '["x-ebay-signature"]', '["x-api-key"]'];
const SECRET_FIELDS = [
  "token",
  "secret",
  "password",
  "clientSecret",
  "apiKey",
  "pass",
  "smtpPassword",
  "SMTP_PASSWORD",
  "ANTHROPIC_API_KEY",
];
// User identifiers in an eBay notification body (ADR 0013).
const USER_FIELDS = ["data.username", "data.userId", "data.eiasToken"];

// Listing content never goes to the log (ADR 0024 backstop).
const CONTENT_FIELDS = ["title", "description", "itemWebUrl", "seller"];

// pino redaction has no recursive wildcard, so fields are matched up to two levels deep.
const FIELD_DEPTHS = ["", "*.", "*.*."];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        ...SECRET_HEADERS.flatMap((header) => [`headers${header}`, `*.headers${header}`]),
        ...[...SECRET_FIELDS, ...USER_FIELDS, ...CONTENT_FIELDS].flatMap((field) => FIELD_DEPTHS.map((depth) => `${depth}${field}`)),
      ],
      censor: "[redacted]",
    },
  };
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(options);
}
