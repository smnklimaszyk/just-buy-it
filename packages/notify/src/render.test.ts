import { startingSegmentRule, type Segment, type SegmentRule } from "@ebay-sniper/domain";
import { describe, expect, it } from "vitest";
import { renderAlertEmail, type AlertEmailInput } from "./render.js";

const gpu3090: SegmentRule = { ...startingSegmentRule("gpu_3090"), ruleVersion: 3 };

// Every detail invented for the test.
const passAlert: AlertEmailInput = {
  deliveryId: "0199f0a0-0000-7000-8000-000000000001",
  rule: gpu3090,
  buyerProfile: "company",
  legacyItemId: "123456789012",
  title: "NVIDIA GeForce RTX 3090 Founders Edition 24GB",
  asOf: new Date("2026-10-21T12:32:00Z"),
  priceCents: 45_900,
  shippingCents: 3_000,
  totalGb: null,
  condition: "Used",
  seller: { accountType: "private", feedbackScore: 250, feedbackPercent: 100 },
  returns: { accepted: false, periodDays: null },
  flags: ["mining_history", "best_offer"],
  descriptionText: "Two years of use, original box.",
  screening: {
    screened: true,
    verdict: "pass",
    productMatch: "match",
    riskFlags: [],
    reason: "Clear description, original box, normal used-market risk.",
  },
  codeSignals: [],
};

describe("renderAlertEmail", () => {
  it("renders the subject and the plain text body of a PASS alert", () => {
    const email = renderAlertEmail(passAlert);
    expect(email.subject).toBe("[Deal] RTX 3090: EUR 489 incl. shipping (94% of max) - PASS");
    expect(email.text).toBe(
      [
        "NVIDIA GeForce RTX 3090 Founders Edition 24GB",
        "As of 14:32 CEST, 21 Oct 2026",
        "",
        "Price:         EUR 459.00",
        "Shipping:      EUR 30.00",
        "Landed price:  EUR 489.00",
        "Rule:          RTX 3090, landed price at most EUR 520.00 (rules v3)",
        "               94% of your maximum",
        "Condition:     Used",
        "Seller:        private, 250 ratings, 100% positive",
        "Returns:       none",
        "Flags:         mining history, best offer possible",
        "",
        "Claude screening: PASS",
        "Reason:        Clear description, original box, normal used-market risk.",
        "Risk flags:    none",
        "",
        "VAT:           Private seller: no VAT invoice, no input-tax deduction.",
        "",
        "Open on eBay:  https://www.ebay.de/itm/123456789012",
        "",
        "Buy only through eBay checkout. Never pay or talk outside eBay.",
        "Check that the listing is still available and the photos match the title.",
        "Company purchase: use the Intra AI business account.",
        "",
        "Delivery 0199f0a0-0000-7000-8000-000000000001 - just-buy-it",
        "",
      ].join("\n"),
    );
  });

  it("puts the same content into an HTML table with every value escaped", () => {
    const title = `RTX 3090 <script>alert("x")</script> & 'Box'`;
    const { html } = renderAlertEmail({ ...passAlert, title });
    expect(html).not.toContain("<script>");
    expect(html).toContain("RTX 3090 &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Box&#39;");
    expect(html).toContain("<table");
    expect(html).toContain("<th>Landed price</th><td>EUR 489.00</td>");
    expect(html).toContain("<th>Seller</th><td>private, 250 ratings, 100% positive</td>");
    expect(html).toContain("As of 14:32 CEST, 21 Oct 2026");
    expect(html).toContain('<a href="https://www.ebay.de/itm/123456789012">https://www.ebay.de/itm/123456789012</a>');
    expect(html).toContain("Claude screening: PASS");
    expect(html).toContain("Clear description, original box, normal used-market risk.");
    expect(html).toContain("Buy only through eBay checkout. Never pay or talk outside eBay.");
    expect(html).toContain("Delivery 0199f0a0-0000-7000-8000-000000000001 - just-buy-it");
  });

  it("marks a caution verdict CHECK, lists the risk flags and boxes the screening in HTML", () => {
    const email = renderAlertEmail({
      ...passAlert,
      rule: { ...startingSegmentRule("gpu_4090"), ruleVersion: 2 },
      priceCents: 115_000,
      shippingCents: 3_000,
      screening: {
        screened: true,
        verdict: "caution",
        productMatch: "match",
        riskFlags: ["mining_history", "no_returns"],
        reason: "Mining use stated; ask about the fan condition.",
      },
    });
    expect(email.subject).toBe("[Deal] RTX 4090: EUR 1,180 incl. shipping (92% of max) - CHECK");
    expect(email.text).toContain(
      [
        "Claude screening: CHECK BEFORE BUYING",
        "Reason:        Mining use stated; ask about the fan condition.",
        "Risk flags:    mining history, no returns",
      ].join("\n"),
    );
    expect(email.html).toMatch(/<div class="warning"[^>]*>\s*<p><strong>Claude screening: CHECK BEFORE BUYING<\/strong>/);
    expect(renderAlertEmail(passAlert).html).not.toContain('class="warning"');
  });

  it("marks a model pass CHECK when the model flagged prompt_injection", () => {
    const email = renderAlertEmail({
      ...passAlert,
      screening: { screened: true, verdict: "pass", productMatch: "match", riskFlags: ["prompt_injection"], reason: "Looks fine." },
    });
    expect(email.subject).toBe("[Deal] RTX 3090: EUR 489 incl. shipping (94% of max) - CHECK");
    expect(email.text).toContain(
      ["Claude screening: CHECK BEFORE BUYING", "Reason:        Looks fine.", "Risk flags:    prompt injection"].join("\n"),
    );
  });

  it("names the rule by its key when this release does not know the key", () => {
    // A product key as v2 writes it; the type only knows the six segments.
    const rule = { ...gpu3090, segment: "p_k3x9ab2cde" as Segment };
    const email = renderAlertEmail({ ...passAlert, rule });
    expect(email.subject).toBe("[Deal] p_k3x9ab2cde: EUR 489 incl. shipping (94% of max) - PASS");
    expect(email.text).toContain("Rule:          p_k3x9ab2cde, landed price at most EUR 520.00 (rules v3)");
  });

  it("marks a model-only block CLAUDE SAYS BLOCK in subject and body, with the reason", () => {
    const email = renderAlertEmail({
      ...passAlert,
      rule: { ...startingSegmentRule("gpu_3090ti"), ruleVersion: 1 },
      priceCents: 53_000,
      shippingCents: 3_000,
      screening: {
        screened: true,
        verdict: "block",
        productMatch: "mismatch",
        riskFlags: ["wrong_model"],
        reason: "The description names a different card than the title.",
      },
    });
    expect(email.subject).toBe("[Deal] RTX 3090 Ti: EUR 560 incl. shipping (93% of max) - CLAUDE SAYS BLOCK");
    expect(email.text).toContain(
      [
        "Claude screening: CLAUDE SAYS BLOCK",
        "Reason:        The description names a different card than the title.",
        "Risk flags:    wrong model",
        "Code checks found no payment or contact scam sign. Read the listing carefully before buying.",
      ].join("\n"),
    );
    expect(email.html).toContain('class="warning"');
    expect(email.html).toContain("Code checks found no payment or contact scam sign.");
  });

  it("renders a not-screened alert from summary data: NOT SCREENED with the code, returns not fetched", () => {
    const email = renderAlertEmail({
      ...passAlert,
      returns: null,
      descriptionText: null,
      screening: { screened: false, code: "cap_reached" },
    });
    expect(email.subject).toBe("[Deal] RTX 3090: EUR 489 incl. shipping (94% of max) - NOT SCREENED");
    expect(email.text).toContain("Returns:       not fetched\n");
    expect(email.text).toContain(
      ["", "Claude screening: NOT SCREENED", "Not screened by Claude: cap_reached. Check the listing yourself.", ""].join(
        "\n",
      ),
    );
    expect(email.text).not.toContain("Reason:");
    expect(email.html).toContain('class="warning"');
    expect(email.html).toContain("Not screened by Claude: cap_reached. Check the listing yourself.");
  });

  it("never counts unknown shipping as zero: the landed price is at least the item price", () => {
    const email = renderAlertEmail({ ...passAlert, shippingCents: null, flags: ["shipping_unknown"] });
    expect(email.subject).toBe("[Deal] RTX 3090: EUR 459 + unknown shipping (88% of max) - PASS");
    expect(email.text).toContain(
      [
        "Price:         EUR 459.00",
        "Shipping:      unknown, landed price at least EUR 459.00",
        "Rule:          RTX 3090, landed price at most EUR 520.00 (rules v3)",
        "               88% of your maximum",
      ].join("\n"),
    );
    expect(email.text).not.toContain("Landed price:");
    expect(email.text).toContain("Flags:         shipping unknown\n");
  });

  it("shows the per-GB price for a RAM segment", () => {
    const email = renderAlertEmail({
      ...passAlert,
      rule: startingSegmentRule("ram_ddr5"),
      title: "2x16GB DDR5-6000 desktop kit",
      priceCents: 15_500,
      shippingCents: 1_000,
      totalGb: 32,
      flags: [],
      screening: { screened: false, code: "not_configured" },
    });
    expect(email.subject).toBe("[Deal] DDR5 32 GB: EUR 165 incl. shipping (EUR 5.16/GB) - NOT SCREENED");
    expect(email.text).toContain(
      [
        "Landed price:  EUR 165.00",
        "Rule:          DDR5, landed price at most EUR 5.60/GB (rules v1)",
        "               32 GB at EUR 5.16/GB, 92% of your maximum",
      ].join("\n"),
    );
  });

  it("describes the return terms getItem gave", () => {
    const returnsLine = (returns: AlertEmailInput["returns"]): string | undefined =>
      renderAlertEmail({ ...passAlert, returns })
        .text.split("\n")
        .find((line) => line.startsWith("Returns:"));
    expect(returnsLine({ accepted: true, periodDays: 30 })).toBe("Returns:       accepted, 30 days");
    expect(returnsLine({ accepted: true, periodDays: null })).toBe("Returns:       accepted");
    expect(returnsLine({ accepted: false, periodDays: null })).toBe("Returns:       none");
    expect(returnsLine({ accepted: null, periodDays: null })).toBe("Returns:       unknown");
    expect(returnsLine(null)).toBe("Returns:       not fetched");
  });

  it("leaves out seller numbers eBay did not give", () => {
    const sellerLine = (seller: AlertEmailInput["seller"]): string | undefined =>
      renderAlertEmail({ ...passAlert, seller })
        .text.split("\n")
        .find((line) => line.startsWith("Seller:"));
    expect(sellerLine({ accountType: "business", feedbackScore: 1_204, feedbackPercent: 99.6 })).toBe(
      "Seller:        business, 1,204 ratings, 99.6% positive",
    );
    expect(sellerLine({ accountType: null, feedbackScore: 3, feedbackPercent: null })).toBe(
      "Seller:        type unknown, 3 ratings",
    );
    expect(sellerLine({ accountType: "private", feedbackScore: null, feedbackPercent: null })).toBe(
      "Seller:        private",
    );
  });

  it("keeps seller and model text on one line and the reason at most 300 characters", () => {
    const email = renderAlertEmail({
      ...passAlert,
      title: "RTX​ 3090\nFounders\r\nEdition",
      screening: { screened: true, verdict: "pass", productMatch: "match", riskFlags: [], reason: `Fine.\n${"a".repeat(399)}` },
    });
    const lines = email.text.split("\n");
    expect(lines[0]).toBe("RTX 3090 Founders Edition");
    const reason = lines.find((line) => line.startsWith("Reason:"))?.slice(15) ?? "";
    expect(reason.startsWith("Fine. aaa")).toBe(true);
    expect([...reason].length).toBe(300);
    expect(email.html).toContain("<strong>RTX 3090 Founders Edition</strong>");
  });

  it("keeps the condition text on one line", () => {
    const { text } = renderAlertEmail({ ...passAlert, condition: "Used\r\nSeller note" });
    expect(text).toContain("Condition:     Used Seller note\n");
  });

  it("takes the VAT line from the buyer profile, the seller type and the description", () => {
    const vatOf = (input: AlertEmailInput): string | undefined =>
      renderAlertEmail(input)
        .text.split("\n")
        .find((line) => line.startsWith("VAT:"));
    const business = { ...passAlert.seller, accountType: "business" as const };
    expect(vatOf({ ...passAlert, seller: business, descriptionText: "Rechnung mit ausgewiesener MwSt." })).toBe(
      "VAT:           Business seller states a VAT invoice. If you get one, the net price is about EUR 410.92.",
    );
    expect(vatOf({ ...passAlert, seller: business })).toBe(
      "VAT:           Business seller. Ask for an invoice with VAT shown before buying.",
    );
    expect(vatOf({ ...passAlert, buyerProfile: "private" })).toBe("VAT:           Private purchase: compared at gross.");
  });

  it("never shows a seller username, even when the caller's object carries one", () => {
    const sentinel = "SENTINEL_SELLER_7f3a";
    const seller = { accountType: "private" as const, feedbackScore: 250, feedbackPercent: 100, username: sentinel };
    const email = renderAlertEmail({ ...passAlert, seller });
    expect(email.subject).not.toContain(sentinel);
    expect(email.text).not.toContain(sentinel);
    expect(email.html).not.toContain(sentinel);
  });

  it("builds the link from the legacy item ID alone, so nothing can add a query or a path", () => {
    const { text } = renderAlertEmail({ ...passAlert, legacyItemId: "123/../x?campid=1" });
    expect(text).toContain("Open on eBay:  https://www.ebay.de/itm/123%2F..%2Fx%3Fcampid%3D1\n");
  });

  it("names the code checks that raised a model pass to CHECK", () => {
    const email = renderAlertEmail({ ...passAlert, codeSignals: ["payment_mention", "hidden_characters"] });
    expect(email.subject).toMatch(/ - CHECK$/);
    expect(email.text).toContain(
      [
        "Claude screening: CHECK BEFORE BUYING",
        "Reason:        Clear description, original box, normal used-market risk.",
        "Risk flags:    none",
        "Code checks:   payment mention, hidden characters",
      ].join("\n"),
    );
    expect(renderAlertEmail(passAlert).text).not.toContain("Code checks:");
  });

  it("refuses to render an alert a code-verified scam floor blocked: it is never emailed", () => {
    expect(() => renderAlertEmail({ ...passAlert, codeSignals: ["iban_present"] })).toThrow(/never emailed/);
  });
});
