import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";
import { describe, expect, it } from "vitest";

const configPath = fileURLToPath(new URL("../../../.dependency-cruiser.cjs", import.meta.url));

async function violatedRules(fixture: string): Promise<string[]> {
  const options = await extractDepcruiseOptions(configPath);
  const baseDir = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
  const { output } = await cruise(["."], { ...options, baseDir });
  if (typeof output === "string") {
    throw new Error("expected a cruise result object");
  }
  return output.summary.violations.map((violation) => violation.rule.name);
}

describe("dependency-cruiser rules", () => {
  it("reports an app importing another app", async () => {
    expect(await violatedRules("app-imports-app")).toEqual(["no-app-to-app"]);
  });

  it("reports nothing for an app importing an allowed package", async () => {
    expect(await violatedRules("clean")).toEqual([]);
  });
});
