import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetManifest } from "./ui/assets.js";

// dist/assets, which scripts/build-assets.ts writes. Only the URLs manifest.json names are served,
// so no request path ever reaches the file system unchecked.
export function assetFiles(dir: string): { readManifest(): Promise<AssetManifest>; file(path: string): Promise<Uint8Array<ArrayBuffer> | null> } {
  let served: Promise<Set<string>> | undefined;
  const readManifest = async (): Promise<AssetManifest> => JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as AssetManifest;
  const urls = (manifest: AssetManifest) => new Set([manifest.styles, ...Object.values(manifest.fonts), ...Object.values(manifest.scripts)]);
  return {
    readManifest,
    async file(path) {
      served ??= readManifest().then(urls);
      if (!(await served).has(path)) return null;
      const bytes = await readFile(join(dir, path.slice("/assets/".length)));
      return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    },
  };
}
