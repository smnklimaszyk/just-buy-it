import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(fileURLToPath(new URL("../../../infra/Dockerfile", import.meta.url)), "utf8");
const lines = dockerfile.split("\n");

describe("infra/Dockerfile", () => {
  // Spec 7.1: one image for server, worker, web and the migrate one-off.
  it("installs, builds and ships the web app with the design system files it reads at run time", () => {
    expect(lines).toContain("COPY apps/web/package.json apps/web/");
    const filters = (stage: string) => {
      const start = lines.findIndex((line) => line.startsWith(`FROM base AS ${stage}`));
      return lines.slice(start, lines.findIndex((line, index) => index > start && line.startsWith("FROM "))).join("\n");
    };
    for (const stage of ["deps", "build"]) {
      expect(filters(stage)).toContain('--filter "@ebay-sniper/web..."');
    }
    expect(lines).toContain("COPY apps/web apps/web");
    expect(lines).toContain("COPY --from=build --chown=node:node /repo/apps/web/dist ./apps/web/dist");
    // ui/core.tsx reads design-system/icons.json next to dist; the fonts ship with their OFL notice.
    expect(lines).toContain("COPY --from=build --chown=node:node /repo/apps/web/design-system ./apps/web/design-system");
  });
});
