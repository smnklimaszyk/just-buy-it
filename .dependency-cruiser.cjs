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
      comment: "No import cycles.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "leaf-packages-import-no-workspace-package",
      comment: "contracts, domain and logging import no other workspace package.",
      severity: "error",
      from: { path: "^packages/(contracts|domain|logging)/" },
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
      name: "web-imports-only-contracts",
      comment: "The web app imports only the contracts package.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/", pathNot: "^packages/contracts/" },
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
      comment: "ops imports only domain, db and logging.",
      severity: "error",
      from: { path: "^apps/ops/" },
      to: { path: "^packages/", pathNot: "^packages/(domain|db|logging)/" },
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
