// Usage: pnpm --filter @ebay-sniper/sync-design-system reference <react folder> [design-system folder]
// <react folder> is any folder from which `react` and `react-dom/server` 18 resolve, for example
// an app of intra-main. React is not a dependency of this repo; it is only needed here, to render
// the design system's reference components into apps/web/src/ui/testing/reference-markup.json.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REFERENCE_CASES } from "../../../apps/web/src/ui/testing/reference-cases.ts";
import { loadReferenceComponents, renderReferenceCases, type ReactLike } from "./reference.ts";

const [reactDir, sourceArg] = process.argv.slice(2);
if (!reactDir) {
  process.stderr.write("Usage: reference <react folder> [design-system folder]\n");
  process.exit(1);
}
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const source = sourceArg ?? join(homedir(), "intra-ai", "design-system");
const require = createRequire(join(resolve(reactDir), "package.json"));
const React = require("react") as ReactLike;
const server = require("react-dom/server") as { renderToStaticMarkup: (element: unknown) => string };

const components = loadReferenceComponents(readFileSync(join(source, "components", "bundle.js"), "utf8"), React);
const markup = renderReferenceCases(REFERENCE_CASES, { components, React, render: server.renderToStaticMarkup });
const out = join(repo, "apps", "web", "src", "ui", "testing", "reference-markup.json");
writeFileSync(out, `${JSON.stringify(markup, null, 2)}\n`);
process.stdout.write(`Wrote ${Object.keys(markup).length} reference cases to ${out}\n`);
