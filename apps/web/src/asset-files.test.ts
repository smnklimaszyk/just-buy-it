import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetFiles } from "./asset-files.js";
import { TEST_ASSETS } from "./testing/harness.js";

// dist/assets as scripts/build-assets.ts leaves it: the hashed files and manifest.json.

describe("assetFiles", () => {
  it("reads the manifest and serves the files it names, and no other file of the folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-assets-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(TEST_ASSETS));
    writeFileSync(join(dir, TEST_ASSETS.styles.slice("/assets/".length)), "body{}");
    writeFileSync(join(dir, "notes.txt"), "not an asset");

    const assets = assetFiles(dir);

    expect(await assets.readManifest()).toEqual(TEST_ASSETS);
    expect(Buffer.from((await assets.file(TEST_ASSETS.styles)) ?? []).toString()).toBe("body{}");
    expect(await assets.file("/assets/notes.txt")).toBeNull();
    expect(await assets.file("/assets/manifest.json")).toBeNull();
    expect(await assets.file("/assets/../package.json")).toBeNull();
  });
});
