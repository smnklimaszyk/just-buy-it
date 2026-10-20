import pino, { type Logger, type LoggerOptions } from "pino";

const SECRET_HEADERS = [".authorization", ".cookie", '["x-ebay-signature"]'];
const SECRET_FIELDS = ["token", "secret", "password", "clientSecret"];
// User identifiers in an eBay notification body (ADR 0013).
const USER_FIELDS = ["data.username", "data.userId", "data.eiasToken"];

// pino redaction has no recursive wildcard, so fields are matched up to two levels deep.
const FIELD_DEPTHS = ["", "*.", "*.*."];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        ...SECRET_HEADERS.flatMap((header) => [`headers${header}`, `*.headers${header}`]),
        ...[...SECRET_FIELDS, ...USER_FIELDS].flatMap((field) => FIELD_DEPTHS.map((depth) => `${depth}${field}`)),
      ],
      censor: "[redacted]",
    },
  };
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(options);
}
