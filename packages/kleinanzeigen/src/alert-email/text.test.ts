import { describe, expect, it } from "vitest";
import { cleanText } from "./text.js";

// Invisible characters are built from code points so this file holds none of them literally.
const char = (codePoint: number) => String.fromCodePoint(codePoint);
const RLO = char(0x202e);
const ZWSP = char(0x200b);
const BELL = char(0x0007);
const LRI = char(0x2066);
const PDI = char(0x2069);
const BOM = char(0xfeff);
const NEL = char(0x0085);
const NBSP = char(0x00a0);
const THIN_SPACE = char(0x2009);
const COMBINING_DIAERESIS = char(0x0308);

describe("cleanText", () => {
  it("collapses whitespace runs and trims", () => {
    expect(cleanText("\n   Gigabyte RTX\t\t4090  \r\n", 200)).toEqual({
      text: "Gigabyte RTX 4090",
      truncated: false,
      hadHiddenCharacters: false,
      hiddenCharacterKinds: [],
    });
  });

  it("removes bidi, zero-width and control characters and reports it", () => {
    const input = `RTX${RLO} 4090${ZWSP} Ti${BELL} ${LRI}OVP${PDI}${BOM}${NEL}`;
    expect(cleanText(input, 200)).toEqual({
      text: "RTX 4090 Ti OVP",
      truncated: false,
      hadHiddenCharacters: true,
      hiddenCharacterKinds: ["bidi_control", "zero_width", "control"],
    });
  });

  it("turns no-break and thin spaces into plain spaces without reporting them as hidden", () => {
    expect(cleanText(`2.450${NBSP}€${THIN_SPACE}VB`, 200)).toEqual({
      text: "2.450 € VB",
      truncated: false,
      hadHiddenCharacters: false,
      hiddenCharacterKinds: [],
    });
  });

  it("cuts at the limit in code points and never splits a surrogate pair", () => {
    const result = cleanText(`${"a".repeat(199)}🎮🎮`, 200);
    expect(result.text).toBe(`${"a".repeat(199)}🎮`);
    expect(Array.from(result.text)).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("never decodes entities a second time", () => {
    expect(cleanText("&lt;script&gt; &amp;amp;", 200).text).toBe("&lt;script&gt; &amp;amp;");
  });

  it("normalizes to NFC", () => {
    expect(cleanText(`Zubeho${COMBINING_DIAERESIS}r`, 200).text).toBe("Zubehör");
  });

  it("normalizes to NFC after removing a character that sat between a letter and its combining mark", () => {
    const result = cleanText(`Zubeho${ZWSP}${COMBINING_DIAERESIS}r`, 200);
    expect(result.text).toBe("Zubehör");
    expect(result.text).toHaveLength(7);
  });

  it.each([
    0xe0001, 0xe0041, 0xe007f, 0xfe0f, 0xfe00, 0xe0100, 0xe01ef, 0x180b, 0x00ad, 0x061c, 0x034f, 0x115f, 0x1160,
    0x3164, 0xffa0, 0x180e, 0xfff9, 0xfffb, 0x17b4, 0x1d173, 0x2065, 0x206f,
  ])("removes the invisible code point %i and reports it", (codePoint) => {
    expect(cleanText(`RTX${char(codePoint)} 4090`, 200)).toMatchObject({ text: "RTX 4090", hadHiddenCharacters: true });
  });

  it.each([
    [0x0007, "control"],
    [0x0085, "control"],
    [0x202e, "bidi_control"],
    [0x202a, "bidi_control"],
    [0x2066, "bidi_control"],
    [0x2069, "bidi_control"],
    [0x200e, "bidi_mark"],
    [0x200f, "bidi_mark"],
    [0x061c, "bidi_mark"],
    [0x200b, "zero_width"],
    [0x200c, "zero_width"],
    [0x200d, "zero_width"],
    [0x2060, "zero_width"],
    [0xfeff, "zero_width"],
    [0x00ad, "soft_hyphen"],
    [0xe0001, "tag"],
    [0xe0041, "tag"],
    [0xe007f, "tag"],
    [0xfe00, "variation_selector"],
    [0xfe0f, "variation_selector"],
    [0xe0100, "variation_selector"],
    [0xe01ef, "variation_selector"],
    [0x180b, "variation_selector"],
    [0x180f, "variation_selector"],
    [0x034f, "other_invisible"],
    [0x3164, "other_invisible"],
    [0x180e, "other_invisible"],
    [0x2061, "other_invisible"],
    [0xfff9, "other_invisible"],
    [0x1d173, "other_invisible"],
  ])("reports the code point %i as %s", (codePoint, kind) => {
    expect(cleanText(`a${char(codePoint)}b`, 200).hiddenCharacterKinds).toEqual([kind]);
  });

  it("gives an empty text for whitespace and hidden characters only", () => {
    expect(cleanText(` ${ZWSP}\n\t `, 200)).toEqual({
      text: "",
      truncated: false,
      hadHiddenCharacters: true,
      hiddenCharacterKinds: ["zero_width"],
    });
  });
});
