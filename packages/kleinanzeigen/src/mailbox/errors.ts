export type MailboxErrorKind = "auth_failed" | "connection_failed" | "timeout" | "protocol";

// The message is fixed and there is no cause, so neither the password nor any server text
// can travel with the error into a log line.
export class MailboxError extends Error {
  readonly kind: MailboxErrorKind;
  readonly code: string | undefined;

  constructor(kind: MailboxErrorKind, code?: string) {
    super(`Kleinanzeigen mailbox: ${kind}`);
    this.name = "MailboxError";
    this.kind = kind;
    this.code = code;
  }
}

const TIMEOUT_CODES = new Set(["CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ETIMEOUT", "ETIMEDOUT"]);

const CONNECTION_CODES = new Set([
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ClosedAfterConnectTLS",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EPROTO",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
]);

// The other codes imapflow documents in ImapFlowErrorCode. imapflow also copies a server response
// code into `code`, which is server text, so only names on these lists are kept.
const PROTOCOL_CODES = new Set([
  "StateLogout",
  "LockTimeout",
  "ETHROTTLE",
  "UnexpectedTag",
  "InvalidResponse",
  "ResponseProcessingFailed",
  "STARTTLS_INJECTION",
  "COMPRESS_TRAILING_DATA",
  "PollFailed",
  "NotFound",
  "MissingServerExtension",
  "ParserError",
  "ParserErrorExchange",
  "ParserErrorInternal",
  "MAX_IMAP_NESTING_REACHED",
  "LineTooLarge",
  "LiteralTooLarge",
  "ResponseTooLarge",
  "InvalidStringValue",
  "InvalidTokenValue",
  "InvalidTextValue",
  "InvalidSequenceSet",
  "InvalidSearchQuery",
  "InvalidMessageContent",
  "DownloadOverflow",
  "DownloadIncomplete",
  "InstanceReused",
]);

// Node's TLS and certificate codes, by shape: CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID,
// ERR_SSL_WRONG_VERSION_NUMBER, UNABLE_TO_VERIFY_LEAF_SIGNATURE, DEPTH_ZERO_SELF_SIGNED_CERT. With
// a direct TLS connect these arrive as plain Node errors (imapflow sets tlsFailed only for
// STARTTLS). The length cap keeps an odd value from passing as a code.
const TLS_CODE =
  /^(?:CERT_[A-Z_]{1,40}|ERR_TLS_[A-Z_]{1,40}|ERR_SSL_[A-Z_]{1,40}|UNABLE_TO_[A-Z_]{1,40}|[A-Z_]{0,30}SELF_SIGNED[A-Z_]{0,30})$/;

function field(err: unknown, name: string): unknown {
  return typeof err === "object" && err !== null ? (err as Record<string, unknown>)[name] : undefined;
}

export function toMailboxError(err: unknown): MailboxError {
  if (err instanceof MailboxError) return err;
  if (field(err, "authenticationFailed") === true || field(err, "serverResponseCode") === "AUTHENTICATIONFAILED") {
    return new MailboxError("auth_failed");
  }
  const raw = field(err, "code");
  const code = typeof raw === "string" ? raw : "";
  if (TIMEOUT_CODES.has(code)) return new MailboxError("timeout", code);
  if (CONNECTION_CODES.has(code) || TLS_CODE.test(code)) return new MailboxError("connection_failed", code);
  if (field(err, "tlsFailed") === true) return new MailboxError("connection_failed");
  if (PROTOCOL_CODES.has(code)) return new MailboxError("protocol", code);
  return new MailboxError("protocol");
}
