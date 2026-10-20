import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, loggerOptions } from "./index.js";

function logOnce(entry: object): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(loggerOptions("info"), { write: (line: string) => lines.push(line) });
  logger.info(entry);
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
}

describe("loggerOptions", () => {
  it("uses the given level", () => {
    expect(loggerOptions("debug").level).toBe("debug");
  });

  it("redacts authorization, cookie and eBay signature headers", () => {
    const logged = logOnce({
      req: {
        headers: {
          authorization: "Bearer abc",
          cookie: "session=abc",
          "x-ebay-signature": "signed",
          accept: "application/json",
        },
      },
    });

    expect(logged["req"]).toEqual({
      headers: {
        authorization: "[redacted]",
        cookie: "[redacted]",
        "x-ebay-signature": "[redacted]",
        accept: "application/json",
      },
    });
  });

  it("redacts token, secret, password and clientSecret fields at the top level and nested", () => {
    const logged = logOnce({
      token: "t",
      secret: "s",
      password: "p",
      clientSecret: "c",
      ebay: { token: "t", clientSecret: "c", clientId: "id" },
      job: { auth: { password: "p", secret: "s" } },
    });

    expect(logged).toMatchObject({
      token: "[redacted]",
      secret: "[redacted]",
      password: "[redacted]",
      clientSecret: "[redacted]",
      ebay: { token: "[redacted]", clientSecret: "[redacted]", clientId: "id" },
      job: { auth: { password: "[redacted]", secret: "[redacted]" } },
    });
  });
});

describe("createLogger", () => {
  it("builds a pino logger from the given options", () => {
    const logger = createLogger(loggerOptions("warn"));

    expect(logger.level).toBe("warn");
    expect(logger.isLevelEnabled("info")).toBe(false);
  });
});
