import { describe, expect, it } from "vitest";
import {
  cleanDescription,
  cleanTitle,
  hasHiddenCharacters,
  htmlToText,
  maskContactData,
  removeHiddenCharacters,
} from "./text.js";

describe("hidden characters", () => {
  it.each([
    ["zero-width space", "30​90", "3090"],
    ["zero-width joiner and non-joiner", "R‍T‌X", "RTX"],
    ["word joiner and BOM", "﻿RTX⁠ 3090", "RTX 3090"],
    ["soft hyphen", "Grafik­karte", "Grafikkarte"],
    ["bidi marks and overrides", "‮abc‬ ‏x‎ ⁦y⁩ ؜z", "abc x y z"],
  ])("removes %s", (_name, input, expected) => {
    expect(hasHiddenCharacters(input)).toBe(true);
    expect(removeHiddenCharacters(input)).toBe(expected);
    expect(hasHiddenCharacters(expected)).toBe(false);
  });
});

describe("maskContactData", () => {
  it.each([
    ["+49 phone", "Ruf an: +49 170 1234567 bitte", "Ruf an: [PHONE] bitte"],
    ["0049 phone", "Tel. 0049-89-12345678", "Tel. [PHONE]"],
    ["mobile without spaces", "WhatsApp 01761234567", "WhatsApp [PHONE]"],
    ["landline with a slash", "Tel 089 / 123 456 78 abends", "Tel [PHONE] abends"],
    ["landline with dashes", "Tel 030-1234-5678", "Tel [PHONE]"],
    ["email", "Schreib an max.muster+gpu@example.org wegen Preis", "Schreib an [EMAIL] wegen Preis"],
    ["IBAN with spaces", "IBAN: DE89 3704 0044 0532 0130 00, danke", "IBAN: [IBAN], danke"],
    ["IBAN without spaces", "DE89370400440532013000", "[IBAN]"],
    ["wa.me link", "https://wa.me/4917012345678", "[CONTACT_LINK]"],
    ["t.me link", "Telegram t.me/gpu_seller_x", "Telegram [CONTACT_LINK]"],
    ["product numbers stay", "RTX 3090 24GB, 3x DP, 2x 8-Pin, Modell 2023, 350 W", "RTX 3090 24GB, 3x DP, 2x 8-Pin, Modell 2023, 350 W"],
    ["memory specs stay", "DDR4 3200 CL16 2x16GB 1.35 V", "DDR4 3200 CL16 2x16GB 1.35 V"],
    ["dates and prices stay", "Gekauft am 01.02.2024 für 1.599,00 EUR", "Gekauft am 01.02.2024 für 1.599,00 EUR"],
  ])("masks %s", (_name, input, expected) => {
    expect(maskContactData(input)).toBe(expected);
  });
});

describe("htmlToText", () => {
  it.each([
    ["tags", "<div><p>RTX <b>3090</b></p><p>Founders</p></div>", "RTX 3090 Founders"],
    ["script, style, iframe and noscript blocks", "A<script>alert('x')</script>B<style>p{}</style>C<iframe src=x>i</iframe>D<noscript>n</noscript>E", "A B C D E"],
    ["upper-case and spaced block tags", "A<SCRIPT type=\"x\">evil()</SCRIPT >B", "A B"],
    ["named entities", "Gr&ouml;&szlig;e &amp; K&uuml;hler &lt;3&gt; &quot;neu&quot; &euro;&nbsp;5", "Größe & Kühler <3> \"neu\" € 5"],
    ["numeric entities", "&#82;&#x54;X &#8364;", "RTX €"],
    ["an unknown entity kept", "a &bogus; b", "a &bogus; b"],
    ["hidden characters and whitespace", "RTX​ 3090\n\n\t  Ti", "RTX 3090 Ti"],
    ["entity-encoded hidden characters", "30&#8203;90", "3090"],
    ["comments", "a<!-- hidden note -->b", "a b"],
    ["NUL characters, which Postgres text cannot store", "RTX\u0000 3090\u0000", "RTX 3090"],
  ])("handles %s", (_name, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });
});

describe("cleanDescription", () => {
  it("cleans, masks and keeps the first 4,500 and last 1,500 characters of a long description", () => {
    const head = "H".repeat(4500);
    const middle = "M".repeat(3000);
    const tail = "T".repeat(1500);
    const html = `<p>${head}</p><script>x()</script><p>${middle}</p><p>${tail}</p>`;
    const result = cleanDescription(html);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(`${head} [...] ${tail}`);

    expect(cleanDescription("<p>Kontakt: info@example.org, 0170 1234567</p>")).toEqual({
      text: "Kontakt: [EMAIL], [PHONE]",
      truncated: false,
    });
    const exact = "x".repeat(6000);
    expect(cleanDescription(exact)).toEqual({ text: exact, truncated: false });
    expect(cleanDescription(`${exact}y`).truncated).toBe(true);
  });
});

describe("cleanTitle", () => {
  it("removes hidden characters, collapses spaces and masks contact data, keeping case", () => {
    expect(cleanTitle("  RTX 30​90   Founders  WhatsApp 0170 1234567 ")).toBe("RTX 3090 Founders WhatsApp [PHONE]");
  });
});
