import { prepareTemplate, testDatabaseAdminUrl } from "./database.js";

// Runs once before the worker tests. Tests never skip: without TEST_DATABASE_URL the run fails.
export default async function setup(): Promise<void> {
  await prepareTemplate(testDatabaseAdminUrl());
}
