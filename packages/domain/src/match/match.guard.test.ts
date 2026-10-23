import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("./", import.meta.url);
const SOURCES = readdirSync(DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), "utf8") }));

// A RegExp call whose arguments are anything but one or two plain string literals.
const STRING = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`;
const LITERAL_CALL = new RegExp(String.raw`^RegExp\s*\(\s*${STRING}\s*(?:,\s*${STRING}\s*)?\)`);

function nonLiteralRegExpCalls(text: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(/\bRegExp\s*\(/g)) {
    const rest = text.slice(match.index);
    if (!LITERAL_CALL.test(rest)) calls.push(rest.slice(0, 60).split("\n")[0] ?? "");
  }
  return calls;
}

describe("match guard (spec 3.3: no RegExp is built from stored text)", () => {
  it.each([
    ["new RegExp(word)", 1],
    ["new RegExp(`${B}${word}`)", 1],
    ['new RegExp("a" + word)', 1],
    ["RegExp(entry.text, 'u')", 1],
    ["new RegExp(\n  word,\n)", 1],
    ['new RegExp("^[a-z]+$", "u")', 0],
    ["new RegExp('x')", 0],
    ["/^[a-z]+$/u.test(word)", 0],
  ])("the check flags %j: %i", (text, count) => {
    expect(nonLiteralRegExpCalls(text)).toHaveLength(count);
  });

  it("reads every source file of match/ and finds no RegExp built from anything but a string literal", () => {
    expect(SOURCES.map((s) => s.name)).toEqual(expect.arrayContaining(["entries.ts", "junk.ts", "match.ts"]));
    expect(SOURCES.flatMap(({ name, text }) => nonLiteralRegExpCalls(text).map((call) => `${name}: ${call}`))).toEqual([]);
  });
});

// Spec 11.2 V2a: no product words in match/*.ts; the junk list holds marketplace words only.
// The terms of the repo guard of spec 10.4, plus the hardware words the old classifier used.
const PRODUCT_SUBSTRINGS = ["3090", "4090", "3080", "4080", "27386", "170083", "gpu_", "ram_ddr", "pc_4090"];
const PRODUCT_WORDS = ["rtx", "gpu", "nvidia", "grafikkarte", "ddr4", "ddr5", "dimm", "sodimm", "ecc", "laptop", "notebook", "vram"];

function productWords(text: string): string[] {
  const lower = text.toLowerCase();
  const words = new Set(lower.split(/[^\p{L}\p{N}]+/u));
  return [...PRODUCT_SUBSTRINGS.filter((s) => lower.includes(s)), ...PRODUCT_WORDS.filter((w) => words.has(w))];
}

describe("match guard (no product words)", () => {
  it("checks the words it should", () => {
    expect(productWords('const M = /3090/; // "RTX" card, "so-dimm", gpu_3090')).toEqual(["3090", "gpu_", "rtx", "gpu", "dimm"]);
    expect(productWords("const NEGATIONS = ['nicht', 'kein*']; // eccentric gpus")).toEqual([]);
  });

  it("finds none in the source files of match/", () => {
    expect(SOURCES.flatMap(({ name, text }) => productWords(text).map((word) => `${name}: ${word}`))).toEqual([]);
  });
});
