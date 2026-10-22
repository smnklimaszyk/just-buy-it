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

  it("reports an adapter package importing another adapter package", async () => {
    expect(await violatedRules("adapter-imports-adapter")).toEqual(["adapters-import-only-domain"]);
  });

  it("reports the server importing the Claude adapter (ADR 0007)", async () => {
    expect(await violatedRules("server-imports-llm")).toEqual(["server-no-llm"]);
  });

  it("reports the server importing the email adapter", async () => {
    expect(await violatedRules("server-imports-notify")).toEqual(["server-no-notify"]);
  });

  it("reports pg-boss imported outside packages/db/src/queue, and only there", async () => {
    expect(await violatedRules("pg-boss-outside-queue")).toEqual(["pg-boss-only-in-queue"]);
  });

  it("reports nodemailer imported outside packages/notify, and only there", async () => {
    expect(await violatedRules("nodemailer-outside-notify")).toEqual(["nodemailer-only-in-notify"]);
  });

  it("reports domain source importing an npm package or a Node module", async () => {
    expect(await violatedRules("domain-imports-runtime")).toEqual(["domain-no-runtime-deps", "domain-no-runtime-deps"]);
  });

  it("reports nothing for an app importing an allowed package", async () => {
    expect(await violatedRules("clean")).toEqual([]);
  });
});
