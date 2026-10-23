import { describe, expect, it } from "vitest";
import { checkWordEntry, entryHits, isNegatedAt, parseEntry, tokenize } from "./entries.js";

describe("checkWordEntry", () => {
  it.each([
    ["search", "Siebträger", "siebträger"],
    ["search", "rtx3090", "rtx3090"],
    ["search", "  Pixel ", "pixel"],
    ["must", "pixel 8", "pixel 8"],
    ["must", "Wasserkühl*", "wasserkühl*"],
    ["must", "so-dimm", "so dimm"],
    ["must", "a b c d", "a b c d"],
    ["warn", "akku*", "akku*"],
    ["exclude", "~ecc", "~ecc"],
    ["exclude", "~sturz*", "~sturz*"],
    ["exclude", "ohne gpu", "ohne gpu"],
    ["exclude", "Ｐｒｏ", "pro"],
    ["exclude", "ka​putt", "kaputt"],
  ] as const)("%s list accepts %j as %j", (list, raw, folded) => {
    expect(checkWordEntry(list, raw)).toEqual({ ok: true, folded });
  });

  it.each([
    ["search", "(a+)+$"],
    ["exclude", "(a+)+$"],
    ["exclude", ".*"],
    ["exclude", "["],
    ["exclude", "\\d"],
    ["exclude", "a".repeat(41)],
    ["must", "ü".repeat(41)],
    ["search", "two words"],
    ["search", "word*"],
    ["search", "~word"],
    ["must", "~word"],
    ["warn", "~word"],
    ["must", "a b c d e"],
    ["must", "*word"],
    ["must", "wo*rd"],
    ["exclude", "~"],
    ["exclude", "word**"],
    ["exclude", "inkl."],
    ["must", ""],
    ["must", "   "],
    ["must", "-"],
  ] as const)("%s list refuses %j", (list, raw) => {
    const result = checkWordEntry(list, raw);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe("parseEntry", () => {
  it.each([
    ["word", { text: "word", tokens: ["word"], prefix: false, negatable: false }],
    ["two words", { text: "two words", tokens: ["two", "words"], prefix: false, negatable: false }],
    ["~sturz*", { text: "~sturz*", tokens: ["sturz"], prefix: true, negatable: true }],
    ["Pixel-8", { text: "pixel 8", tokens: ["pixel", "8"], prefix: false, negatable: false }],
    ["  ~Kein_Bild* ", { text: "~kein bild*", tokens: ["kein", "bild"], prefix: true, negatable: true }],
  ])("%j", (raw, expected) => {
    expect(parseEntry(raw)).toEqual(expected);
  });
});

describe("tokenize", () => {
  it.each([
    ["Canon EF 50mm f/1.8, top!", ["canon", "ef", "50mm", "f", "1", "8", "top"]],
    ["2×16GB", ["2", "x", "16gb"]],
    ["", []],
    ["  ,.  ", []],
    ["R​TX 30​90", ["rtx", "3090"]],
    ["Größe XL", ["größe", "xl"]],
    ["Ｆａｈｒｒａｄ", ["fahrrad"]],
  ])("%j", (title, tokens) => {
    expect(tokenize(title)).toEqual(tokens);
  });
});

describe("entryHits", () => {
  it.each([
    ["a whole token", "Rennrad 28 Zoll", "rennrad", [0]],
    ["no part of a token", "Rennradrahmen 28 Zoll", "rennrad", []],
    ["a prefix on the last token", "mit Wasserkühlung", "wasserkühl*", [1]],
    ["consecutive tokens", "Google Pixel 8 Pro", "pixel 8", [1]],
    ["tokens out of order", "Google 8 Pixel", "pixel 8", []],
    ["the prefix only on the last token", "Pixelbook 8a", "pixel 8*", []],
    ["a two-word prefix", "Pixel 8a", "pixel 8*", [0]],
    ["every position", "Kaffee und Kaffee", "kaffee", [0, 2]],
    ["an entry longer than the rest of the title", "Pixel", "pixel 8", []],
    ["text inside a compound", "Grafikkartenhalterung", "halterung", []],
    ["a negatable entry as a plain one", "starke Kratzer", "~kratzer", [1]],
    ["stored text that never passed the grammar", "a aa (a+)+$", "(a+)+$", []],
    ["an empty entry", "word", "", []],
  ] as const)("%s", (_name, title, entry, expected) => {
    expect(entryHits(tokenize(title), parseEntry(entry))).toEqual(expected);
  });
});

describe("isNegatedAt", () => {
  it.each([
    ["nicht directly before", "nicht defekt", 1, true],
    ["keine directly before", "keine Kratzer", 1, true],
    ["keinerlei, as kein*", "keinerlei Kratzer", 1, true],
    ["ohne two tokens before", "ohne grosse Kratzer", 2, true],
    ["non before a folded hyphen", "DDR4 Non-ECC", 2, true],
    ["not", "not working", 1, true],
    ["no", "no signal", 1, true],
    ["frei", "frei von Kratzern", 2, true],
    ["a negation three tokens before", "nicht sehr grosse Kratzer", 3, false],
    ["a negation after", "Kratzer keine", 0, false],
    ["no negation", "starke Kratzer", 1, false],
    ["the first token", "Kratzer", 0, false],
    ["a word that starts like a negation", "nichts als Kratzer", 2, false],
  ] as const)("%s", (_name, title, at, expected) => {
    expect(isNegatedAt(tokenize(title), at)).toBe(expected);
  });
});
