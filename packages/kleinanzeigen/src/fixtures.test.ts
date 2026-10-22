import { readdirSync, readFileSync } from "node:fs";
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";

// The fixtures are real Kleinanzeigen emails with every identifier swapped for a value from a fake
// range (see testing/fixtures/PROVENANCE.md). This test keeps it that way when a fixture is added.

const fixturesDir = new URL("./testing/fixtures/", import.meta.url);

const EXPECTED_FILES = [
  "activation.eml",
  "alert-gpu-5090.eml",
  "alert-gpu-fixed.eml",
  "alert-gpu-negotiable.eml",
  "alert-pc-fixed.eml",
  "alert-ram-business.eml",
];

const FAKE_AD_ID = /^90000000(?!00)\d{2}$/;
const FAKE_SAVED_SEARCH_ID = /^9000000(?!00)\d{2}$/;
const FAKE_IMAGE_UUID = /^00000000-0000-4000-8000-0000000000(?!00)\d{2}$/;
const FAKE_MESSAGE_ID = /^<10000000\d{2}\.1\.1792580000000@saved-search-application-fixture>$/;
const DROPPED_HEADER = /^(?:x-sg-|x-entity-id$|x-spam|x-rspamd-)/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const REAL_ID_SHAPES = /35[0-9]{8}|77[0-9]{7}/;
const ALLOWED_OWN_HOST = /Authentication-Results: mail\.intra-ai\.de;|\b(?:by|from) mail\.intra-ai\.de\b/g;

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[0]);
}

const emlFiles = readdirSync(fixturesDir)
  .filter((name) => name.endsWith(".eml"))
  .sort();

describe("sanitized fixtures", () => {
  it("has exactly the expected files", () => {
    expect(emlFiles).toEqual(EXPECTED_FILES);
  });

  describe.each(emlFiles)("%s", (name) => {
    const raw = readFileSync(new URL(name, fixturesDir), "utf8");

    it("uses CRLF line ends only", () => {
      expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    });

    it("opens in postal-mime with an html body from Kleinanzeigen", async () => {
      const email = await PostalMime.parse(raw);
      expect(email.html?.length ?? 0).toBeGreaterThan(0);
      expect(email.from?.address).toBe("noreply@kleinanzeigen.de");
    });

    it("keeps every ad, saved-search and image id inside the fake ranges", async () => {
      const html = (await PostalMime.parse(raw)).html ?? "";
      const adIds = matchAll(html, /\/s-anzeige\/(\d+)/g);
      const savedSearchIds = [
        ...matchAll(html, /m-suche-verwenden\.html\?id=(\d+)/g),
        ...matchAll(html, /[?&]sa=(\d+)/g),
      ];
      const imageFolders = matchAll(html, /\/prod-ads\/images\/([^/"]+)\//g);
      const uuids = [...matchAll(raw, UUID), ...matchAll(html, UUID)];
      const expectedCount = name.startsWith("alert-") ? 1 : 0;
      expect(adIds).toHaveLength(expectedCount);
      expect(savedSearchIds).toHaveLength(2 * expectedCount);
      expect(imageFolders).toHaveLength(expectedCount);
      for (const id of adIds) expect(id).toMatch(FAKE_AD_ID);
      for (const id of savedSearchIds) expect(id).toMatch(FAKE_SAVED_SEARCH_ID);
      for (const folder of imageFolders) expect(folder).toBe("00");
      for (const uuid of uuids) expect(uuid).toMatch(FAKE_IMAGE_UUID);
    });

    it("has no open-pixel token, real bounce token or real id shape", async () => {
      const html = (await PostalMime.parse(raw)).html ?? "";
      for (const text of [raw, html]) {
        expect(text).not.toContain("upn=u001");
        expect(text).not.toContain("bounces+5");
        expect(text).not.toMatch(REAL_ID_SHAPES);
      }
      for (const upn of matchAll(html, /upn=([^"&]*)/g)) expect(upn).toBe("FIXTURE");
    });

    // Ids can hide in shapes the link patterns above do not know (a click-wrapped link with the ad id
    // in a query value, a slug path), and a real id need not start like today's ones. So every run of
    // six or more digits must be zeros, a fake id, or one of a few named public numbers.
    it("has no long digit run outside the fake ranges", async () => {
      const html = (await PostalMime.parse(raw)).html ?? "";
      const body = html.replace(/#[0-9a-f]{6}\b/gi, "");
      const headers = raw
        .slice(0, raw.indexOf("\r\n\r\n"))
        .replace(/\r\n[ \t]+/g, " ")
        .replace(/\b\d{2}:\d{2}:\d{2}\.\d+/g, "")
        .replace(/\bm=\+\d+\.\d+/g, "")
        .replace(/\bt=\d+/g, "")
        .replace(/<10000000\d{2}\.1\.1792580000000@/g, "");
      // Public numbers in Kleinanzeigen's own footer: the App Store app id and the company register number.
      const publicNumbers = ["382596778", "272623"];
      const fakeImageUuidTail = /^0000000000(?!00)\d{2}$/;
      const runs = [...matchAll(body, /(\d{6,})/g), ...matchAll(headers, /(\d{6,})/g)];
      const unexpected = runs.filter(
        (run) =>
          !/^0+$/.test(run) &&
          !FAKE_AD_ID.test(run) &&
          !FAKE_SAVED_SEARCH_ID.test(run) &&
          !fakeImageUuidTail.test(run) &&
          !publicNumbers.includes(run),
      );
      expect(unexpected).toEqual([]);
    });

    // A real seller's title must never reach the repo. The sanitize step swaps it in the image alt
    // text and in the bold title cell; a new fixture adds its invented title to this list.
    it("carries only an invented listing title, in both places it appears", async () => {
      const inventedTitles = [
        "Gigabyte RTX 4090 Gaming OC 24GB mit Rechnung",
        "Palit RTX 5090 GameRock 32GB OVP mit Zubehör",
        "Gaming PC Ryzen 7 5800X3D mit RTX 3090 24GB und 32GB RAM",
        "Zotac RTX 4090 Trinity OC 24GB mit Wasserkühler",
        "Kingston Fury Beast DDR5 32 GB 5600MHz Kit",
      ];
      const html = (await PostalMime.parse(raw)).html ?? "";
      const altTitles = matchAll(html, /alt="Bild zur Anzeige ([^"\r\n]+)/g).map((title) => title.trim());
      expect(altTitles).toHaveLength(name.startsWith("alert-") ? 1 : 0);
      for (const title of altTitles) {
        expect(inventedTitles).toContain(title);
        expect(html.split(title)).toHaveLength(3);
      }
    });

    it("names our mail server only as authserv-id and hop", async () => {
      const html = (await PostalMime.parse(raw)).html ?? "";
      const unfoldedHeaders = raw.slice(0, raw.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " ");
      expect(unfoldedHeaders.replace(ALLOWED_OWN_HOST, "")).not.toContain("intra-ai");
      expect(html).not.toContain("intra-ai");
    });

    it("has a fake Message-ID, the placeholder mailbox and no tracking headers", async () => {
      const email = await PostalMime.parse(raw);
      const values = (key: string) => email.headers.filter((h) => h.key === key).map((h) => h.value);
      expect(email.messageId).toMatch(FAKE_MESSAGE_ID);
      expect(values("to")).toEqual(["mailbox@example.invalid"]);
      expect(values("delivered-to")).toEqual(["mailbox@example.invalid"]);
      expect(values("return-path")).toEqual([
        "<bounces+0000000-0000-mailbox=example.invalid@em4286.kleinanzeigen.de>",
      ]);
      expect(email.headers.map((h) => h.key).filter((key) => DROPPED_HEADER.test(key))).toEqual([]);
    });
  });

  it("gives the activation email a body without any link", async () => {
    const email = await PostalMime.parse(readFileSync(new URL("activation.eml", fixturesDir), "utf8"));
    expect(email.subject).toBe("Aktiviere dein Konto bei Kleinanzeigen");
    expect(email.html).not.toMatch(/<a\b|href|https?:/i);
  });

  it("keeps real ids out of PROVENANCE.md", () => {
    const provenance = readFileSync(new URL("PROVENANCE.md", fixturesDir), "utf8");
    expect(provenance).not.toMatch(REAL_ID_SHAPES);
    expect(provenance.match(UUID) ?? []).toEqual([]);
    expect(provenance).not.toContain("upn=u001");
    expect(provenance).not.toContain("intra-ai");
  });
});
