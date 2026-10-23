import { describe, expect, it } from "vitest";
import { checkWordEntry, foldEntry, tokenize } from "./entries.js";
import { DEFAULT_JUNK_RULES, isJunkRuleId, JUNK_REASONS, junkReason } from "./junk.js";

describe("junkReason", () => {
  it.each([
    ["Suche Rennrad 28 Zoll", "wanted_ad"],
    ["Gesucht: Siebträger", "wanted_ad"],
    ["WTB Pixel 8", "wanted_ad"],
    ["Ankauf von Objektiven", "wanted_ad"],
    ["Kaufe Lego Sets", "wanted_ad"],
    ["Verkaufe mein Rennrad", null],
    ["Versuche es mal", null],
    ["Rennrad zur Miete", "rental"],
    ["Objektiv mieten", "rental"],
    ["Vermiete Kaffeemaschine", "rental"],
    ["Lens for rent", "rental"],
    ["Rennrad defekt", "defective"],
    ["Defekte Kaffeemaschine", "defective"],
    ["Für Bastler", "defective"],
    ["Bastlerware", "defective"],
    ["Display kaputt", "defective"],
    ["for parts or repair", "defective"],
    ["als Ersatzteil", "defective"],
    ["funktioniert nicht", "defective"],
    ["ohne Funktion", "defective"],
    ["not working", "defective"],
    ["broken screen", "defective"],
    ["Rahmen beschädigt", "defective"],
    ["damaged box", "defective"],
    ["no signal", "defective"],
    ["kein Bild", "defective"],
    ["Bildfehler, Artefakte", "defective"],
    ["shows artifacts", "defective"],
    ["nicht defekt", null],
    ["keine Defekte", null],
    ["ohne Defekte", null],
    ["not broken", null],
    ["nicht beschädigt", null],
    ["unbeschädigt", null],
    ["defektfrei", null],
    ["artefaktfrei", null],
    ["keine Artefakte", null],
    ["nur OVP", "box_or_picture_only"],
    ["Nur die OVP", "box_or_picture_only"],
    ["nur Verpackung", "box_or_picture_only"],
    ["Box only", "box_or_picture_only"],
    ["OVP only", "box_or_picture_only"],
    ["leere OVP", "box_or_picture_only"],
    ["leerer Karton", "box_or_picture_only"],
    ["Karton ohne Inhalt", "box_or_picture_only"],
    ["empty box", "box_or_picture_only"],
    ["nur Foto", "box_or_picture_only"],
    ["nur Bilder", "box_or_picture_only"],
    ["photo of", "box_or_picture_only"],
    ["mit OVP", null],
    ["OVP nur kurz geöffnet", null],
    ["Konvolut Objektive", "bundle"],
    ["Bundle of lenses", "bundle"],
    ["Lot of 4", "bundle"],
    ["Suche defekte Geräte", "wanted_ad"],
  ] as const)("%j", (title, reason) => {
    expect(junkReason([tokenize(title)], [])).toBe(reason);
  });

  it("skips the rules a product turns off and goes on with the next", () => {
    const runs = [tokenize("Suche defektes Rennrad")];
    expect(junkReason(runs, ["wanted"])).toBe("defective");
    expect(junkReason(runs, ["wanted", "defect"])).toBe(null);
  });

  it("checks each run on its own, so no entry spans two fields", () => {
    expect(junkReason([tokenize("Rennrad nur"), tokenize("OVP")], [])).toBe(null);
    expect(junkReason([tokenize("Rennrad"), tokenize("Gebraucht, defekt")], [])).toBe("defective");
  });
});

describe("DEFAULT_JUNK_RULES", () => {
  it("is valid data: unique ids, grammar entries, reasons that fit seen_item.outcome", () => {
    const ids = DEFAULT_JUNK_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(isJunkRuleId)).toBe(true);
    expect(isJunkRuleId("missing")).toBe(false);
    const entries = DEFAULT_JUNK_RULES.flatMap((rule) => [...rule.entries, ...rule.allow]);
    expect(entries.filter((entry) => !checkWordEntry("must", entry).ok || foldEntry(entry) !== entry)).toEqual([]);
    expect(DEFAULT_JUNK_RULES.every((rule) => JUNK_REASONS.includes(rule.reason))).toBe(true);
    expect(JUNK_REASONS.filter((reason) => !/^[a-z][a-z0-9_]{0,39}$/.test(reason))).toEqual([]);
  });
});
