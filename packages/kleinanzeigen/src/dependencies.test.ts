import { describe, expect, it } from "vitest";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import PostalMime, { type Email } from "postal-mime";
import { parse, type DefaultTreeAdapterMap } from "parse5";

describe("dependencies", () => {
  it("parses a small email with postal-mime", async () => {
    const email: Email = await PostalMime.parse(
      "From: a@example.invalid\r\nSubject: Hallo\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hi</p>\r\n",
    );
    expect(email.subject).toBe("Hallo");
    expect(email.html).toContain("<p>Hi</p>");
  });

  it("builds a browser-style tree with parse5", () => {
    const document: DefaultTreeAdapterMap["document"] = parse("<p>Preis: 400&nbsp;&euro;");
    expect(document.childNodes[0]?.nodeName).toBe("html");
  });

  it("creates an ImapFlow client without connecting", () => {
    const options: ImapFlowOptions = {
      host: "imap.example.invalid",
      port: 993,
      secure: true,
      auth: { user: "user", pass: "not-a-secret" },
      logger: false,
    };
    const client = new ImapFlow(options);
    expect(client.usable).toBe(false);
  });
});
