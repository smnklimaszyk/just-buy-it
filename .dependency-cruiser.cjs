// Import rules from ADR 0006. Paths are matched against resolved file paths relative to the
// cruise base directory, so each rule also covers apps and packages that do not exist yet.
const WORKSPACE = "^(apps|packages)/";

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-app-to-app",
      comment: "An app never imports another app.",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "no-circular",
      comment: "No import cycles. A cycle through type-only imports is erased at build time, so it does not count.",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "leaf-packages-import-no-workspace-package",
      comment: "contracts, domain, logging and kleinanzeigen import no other workspace package.",
      severity: "error",
      from: { path: "^packages/(contracts|domain|logging|kleinanzeigen)/" },
      to: { path: WORKSPACE, pathNot: "^packages/$1/" },
    },
    {
      name: "domain-no-runtime-deps",
      comment: "domain is pure: no npm package and no Node module outside its tests.",
      severity: "error",
      from: { path: "^packages/domain/src/", pathNot: "\\.(test|spec)\\.[cm]?[jt]sx?$" },
      to: { pathNot: "^(apps|packages)/" },
    },
    {
      name: "adapters-import-only-domain",
      comment: "ebay, llm, notify and db import only domain.",
      severity: "error",
      from: { path: "^packages/(ebay|llm|notify|db)/" },
      to: { path: WORKSPACE, pathNot: "^packages/($1|domain)/" },
    },
    {
      name: "server-no-llm",
      comment: "The server never calls Anthropic (ADR 0007): only the worker imports the Claude adapter.",
      severity: "error",
      from: { path: "^apps/server/" },
      to: { path: "^packages/llm/" },
    },
    {
      name: "server-no-notify",
      comment: "The server sends no alert email: only the worker imports the email adapter.",
      severity: "error",
      from: { path: "^apps/server/" },
      to: { path: "^packages/notify/" },
    },
    {
      name: "pg-boss-only-in-queue",
      comment: "pg-boss is used only through packages/db/src/queue (MVP section 2.2).",
      severity: "error",
      from: { pathNot: "^packages/db/src/queue/" },
      // A resolved import lands in node_modules; one that cannot be resolved keeps its bare name.
      to: { path: "(^|/)node_modules/pg-boss/|^pg-boss$" },
    },
    {
      name: "nodemailer-only-in-notify",
      comment: "nodemailer is used only through packages/notify (ADR 0035).",
      severity: "error",
      from: { pathNot: "^packages/notify/" },
      to: { path: "(^|/)node_modules/nodemailer/|^nodemailer$" },
    },
    {
      name: "web-imports-only-its-packages",
      comment:
        "ADR 0039: apps/web imports contracts, domain, the db main entry, notify, logging and the llm catalog, never ebay or the rest of llm.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/", pathNot: "^packages/(contracts|domain|db|notify|logging)/|^packages/llm/src/catalog\\.ts$" },
    },
    {
      name: "web-no-queue",
      comment: "ADR 0039: apps/web never imports @ebay-sniper/db/queue; web touches no pg-boss job.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/db/src/queue/index\\.ts$|^packages/db/src/queue/(start|registry|migrate-queue)\\.ts$" },
    },
    {
      name: "web-never-reaches-claude-or-pg-boss",
      comment: "ADR 0007 and 0039: nothing apps/web imports leads to the Claude adapter or to pg-boss.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/llm/src/adapter\\.ts$|(^|/)node_modules/pg-boss/", reachable: true },
    },
    {
      name: "worker-no-contracts",
      comment: "The worker does not import the HTTP API contracts.",
      severity: "error",
      from: { path: "^apps/worker/" },
      to: { path: "^packages/contracts/" },
    },
    {
      name: "ops-imports-only-domain-db-logging",
      comment: "ops imports only domain, db, logging and the llm catalog (the eval list for settings set).",
      severity: "error",
      from: { path: "^apps/ops/" },
      to: { path: "^packages/", pathNot: "^packages/(domain|db|logging)/|^packages/llm/src/catalog\\.ts$" },
    },
    {
      name: "no-dev-deps-in-src",
      comment: "Source files other than tests do not import devDependencies.",
      severity: "error",
      from: { path: "^(apps|packages)/[^/]+/src/", pathNot: "\\.(test|spec)\\.[cm]?[jt]sx?$" },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(apps|packages)/[^/]+/(dist|coverage|\\.turbo)/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      // "source" points workspace packages at their TypeScript sources, so the graph does not depend on a build.
      conditionNames: ["source", "import", "require", "node", "default"],
    },
  },
};
