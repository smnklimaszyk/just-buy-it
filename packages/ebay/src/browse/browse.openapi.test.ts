import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { itemSummarySchema, searchPageSchema } from "./schemas.js";

// Manual conformance check against the pinned Browse OpenAPI file. Run it with
// `pnpm --filter @ebay-sniper/ebay openapi:check`, which downloads the file first. Never in CI.

const packageRoot = new URL("../../", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("openapi/browse.lock.json", packageRoot), "utf8")) as {
  url: string;
  version: string;
  sha256: string;
};
const specText = readFileSync(new URL(".openapi/buy_browse_v1_oas3.json", packageRoot), "utf8");
type JsonSchema = {
  type?: string | string[];
  $ref?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};
const spec = JSON.parse(specText) as {
  info: { version: string };
  components: { schemas: Record<string, JsonSchema> };
};

function resolve(schema: JsonSchema): JsonSchema {
  let current = schema;
  while (current.$ref) {
    const target = spec.components.schemas[current.$ref.replace("#/components/schemas/", "")];
    if (!target) throw new Error(`unresolved $ref ${current.$ref}`);
    current = target;
  }
  return current;
}

// integer and number count as the same type.
const typeGroup = (type: string | string[] | undefined) => (type === "integer" ? "number" : String(type));

// Every property path we declare, checked against the spec: missing paths and type differences.
function mismatches(ours: JsonSchema, theirs: JsonSchema, path = "$"): string[] {
  const target = resolve(theirs);
  const found: string[] = [];
  if (ours.type !== undefined && typeGroup(ours.type) !== typeGroup(target.type)) {
    found.push(`${path}: ${String(ours.type)} here, ${String(target.type)} in the spec`);
  }
  for (const [name, child] of Object.entries(ours.properties ?? {})) {
    const theirChild = target.properties?.[name];
    if (theirChild) found.push(...mismatches(child, theirChild, `${path}.${name}`));
    else found.push(`${path}.${name}: not in the spec`);
  }
  if (ours.items && target.items) found.push(...mismatches(ours.items, target.items, `${path}[]`));
  return found;
}

const specSchema = (name: string): JsonSchema => {
  const schema = spec.components.schemas[name];
  if (!schema) throw new Error(`${name} is not in the spec`);
  return schema;
};

describe("Browse OpenAPI file", () => {
  it("matches the hash and version in the lock", () => {
    expect(createHash("sha256").update(specText).digest("hex")).toBe(lock.sha256);
    expect(spec.info.version).toBe(lock.version);
  });

  it("has every field our schemas declare, with the same type", () => {
    expect(mismatches(z.toJSONSchema(searchPageSchema) as JsonSchema, specSchema("SearchPagedCollection"))).toEqual(
      [],
    );
    expect(mismatches(z.toJSONSchema(itemSummarySchema) as JsonSchema, specSchema("ItemSummary"))).toEqual([]);
  });

  it("reports a field the spec lacks and a field with another type", () => {
    const scratch = itemSummarySchema.extend({
      bidCount: z.string(),
      notInSpec: z.string(),
      seller: z.object({ feedbackScore: z.boolean() }),
    });

    expect(mismatches(z.toJSONSchema(scratch) as JsonSchema, specSchema("ItemSummary")).sort()).toEqual([
      "$.bidCount: string here, integer in the spec",
      "$.notInSpec: not in the spec",
      "$.seller.feedbackScore: boolean here, integer in the spec",
    ]);
  });
});
