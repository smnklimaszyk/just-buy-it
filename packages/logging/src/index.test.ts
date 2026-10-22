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

describe("loggerOptions Claude and SMTP secrets", () => {
  it("redacts the x-api-key header on headers and nested headers", () => {
    const logged = logOnce({
      headers: { "x-api-key": "secret-key", accept: "application/json" },
      req: { headers: { "x-api-key": "secret-key", accept: "application/json" } },
    });

    expect(logged).toMatchObject({
      headers: { "x-api-key": "[redacted]", accept: "application/json" },
      req: { headers: { "x-api-key": "[redacted]", accept: "application/json" } },
    });
    expect(JSON.stringify(logged)).not.toMatch(/secret-/);
  });

  it("redacts apiKey, pass, smtpPassword, SMTP_PASSWORD and ANTHROPIC_API_KEY at depths 0 to 2", () => {
    const secrets = {
      apiKey: "secret-api-key",
      pass: "secret-pass",
      smtpPassword: "secret-smtp-password",
      SMTP_PASSWORD: "secret-smtp-env",
      ANTHROPIC_API_KEY: "secret-anthropic-env",
      host: "kept",
    };
    const hidden = {
      apiKey: "[redacted]",
      pass: "[redacted]",
      smtpPassword: "[redacted]",
      SMTP_PASSWORD: "[redacted]",
      ANTHROPIC_API_KEY: "[redacted]",
      host: "kept",
    };

    const logged = logOnce({ ...secrets, smtp: secrets, config: { auth: secrets } });

    expect(logged).toMatchObject({ ...hidden, smtp: hidden, config: { auth: hidden } });
    expect(JSON.stringify(logged)).not.toMatch(/secret-/);
  });
});

describe("loggerOptions listing content", () => {
  it("redacts title, description, itemWebUrl and seller at depths 0 to 2", () => {
    const listing = {
      title: "content-title",
      description: "content-description",
      itemWebUrl: "https://example.invalid/content-url",
      seller: { username: "content-seller", feedbackScore: 5 },
      segment: "gpu_3090",
    };
    const hidden = {
      title: "[redacted]",
      description: "[redacted]",
      itemWebUrl: "[redacted]",
      seller: "[redacted]",
      segment: "gpu_3090",
    };

    const logged = logOnce({ ...listing, item: listing, job: { item: listing } });

    expect(logged).toMatchObject({ ...hidden, item: hidden, job: { item: hidden } });
    expect(JSON.stringify(logged)).not.toMatch(/content-/);
  });
});

describe("loggerOptions user fields", () => {
  it("redacts data.username, data.userId and data.eiasToken at depths 0 to 2", () => {
    const user = { username: "secret-username", userId: "secret-user-id", eiasToken: "secret-eias-token", other: "kept" };
    const hidden = { username: "[redacted]", userId: "[redacted]", eiasToken: "[redacted]", other: "kept" };

    const logged = logOnce({
      data: user,
      notification: { data: user },
      body: { notification: { data: user } },
    });

    expect(logged).toMatchObject({
      data: hidden,
      notification: { data: hidden },
      body: { notification: { data: hidden } },
    });
    expect(JSON.stringify(logged)).not.toMatch(/secret-/);
  });
});

describe("createLogger", () => {
  it("builds a pino logger from the given options", () => {
    const logger = createLogger(loggerOptions("warn"));

    expect(logger.level).toBe("warn");
    expect(logger.isLevelEnabled("info")).toBe(false);
  });
});
