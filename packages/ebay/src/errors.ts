export type EbayErrorKind =
  | "timeout"
  | "network"
  | "aborted"
  | "rate_limited"
  | "unauthorized"
  | "client_error"
  | "server_error"
  | "invalid_response"
  | "quota_refused"
  // No eBay credentials configured, so no request was sent.
  | "not_configured";

export type EbayOperation = "token" | "public_key" | "search" | "get_item";

export type EbayErrorFields = {
  kind: EbayErrorKind;
  operation: EbayOperation;
  status?: number | undefined;
  errorIds?: readonly number[];
  attempts: number;
};

// The message is fixed so it never carries a response body, query, token or key id.
export class EbayError extends Error {
  readonly kind: EbayErrorKind;
  readonly operation: EbayOperation;
  readonly status: number | undefined;
  readonly errorIds: readonly number[];
  readonly attempts: number;

  constructor(fields: EbayErrorFields) {
    const status = fields.status === undefined ? "" : ` (HTTP ${fields.status})`;
    super(`eBay ${fields.operation} failed: ${fields.kind}${status}`);
    this.name = "EbayError";
    this.kind = fields.kind;
    this.operation = fields.operation;
    this.status = fields.status;
    this.errorIds = fields.errorIds ?? [];
    this.attempts = fields.attempts;
  }
}
