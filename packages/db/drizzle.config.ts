import { defineConfig } from "drizzle-kit";

// No dbCredentials and no env: generate needs neither (ADR 0006). schemaFilter keeps a later
// pull away from the pgboss schema; generate takes its schemas from pgSchema().
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  schemaFilter: ["app", "auth", "ebay_live"],
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
});
