import { describe, expect, it } from "vitest";
import * as kleinanzeigen from "./index.js";
import type {
  AlertParseResult,
  AlertRejectDetail,
  AlertRejectReason,
  FetchNewResult,
  HiddenCharacterKind,
  KleinanzeigenListing,
  KleinanzeigenPrice,
  MailboxErrorKind,
  MailboxMessage,
  MailboxReader,
  MailboxReaderOptions,
  MailboxState,
  ParseAlertOptions,
  ParsedAlert,
  PriceKind,
  RejectedAlert,
  SellerType,
} from "./index.js";

// The public types are named here so typecheck fails when one goes missing from the entry point.
export type PublicTypes = [
  AlertParseResult,
  AlertRejectDetail,
  AlertRejectReason,
  FetchNewResult,
  HiddenCharacterKind,
  KleinanzeigenListing,
  KleinanzeigenPrice,
  MailboxErrorKind,
  MailboxMessage,
  MailboxReader,
  MailboxReaderOptions,
  MailboxState,
  ParseAlertOptions,
  ParsedAlert,
  PriceKind,
  RejectedAlert,
  SellerType,
];

describe("package entry point", () => {
  it("exports the parser, the reader and the error, and nothing else at runtime", () => {
    expect(Object.keys(kleinanzeigen).sort()).toEqual([
      "DEFAULT_TRUSTED_AUTHSERV_ID",
      "MailboxError",
      "createMailboxReader",
      "parseAlertEmail",
    ]);
    expect(kleinanzeigen.DEFAULT_TRUSTED_AUTHSERV_ID).toBe("mail.intra-ai.de");
  });
});
