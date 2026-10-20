import type { TestProject } from "vitest/node";
import { runMigrations } from "./src/migrate.js";
import { adminQuery, TEMPLATE_DATABASE } from "./src/testing/database.js";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseAdminUrl: string;
  }
}

// Runs once before the db tests. Tests never skip: without TEST_DATABASE_URL the run fails.
// The migrated template lets each test file copy a ready schema with CREATE DATABASE ... TEMPLATE.
export default async function setup(project: TestProject): Promise<void> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (adminUrl === undefined || adminUrl === "") {
    throw new Error("TEST_DATABASE_URL is not set: start Postgres, see README (Local Postgres for tests)");
  }

  await adminQuery(adminUrl, `DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
  await adminQuery(adminUrl, `CREATE DATABASE ${TEMPLATE_DATABASE}`);
  const templateUrl = new URL(adminUrl);
  templateUrl.pathname = `/${TEMPLATE_DATABASE}`;
  await runMigrations({ connectionString: templateUrl.toString(), log: () => undefined });

  project.provide("testDatabaseAdminUrl", adminUrl);
}
