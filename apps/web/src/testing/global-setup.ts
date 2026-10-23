import { prepareTemplate } from "./database.js";

// Runs once before the web tests and migrates the template the database tests copy. The UI kit
// and page script tests need no database, so without TEST_DATABASE_URL only the database tests
// fail (createTestDatabase throws); none of them skips.
export default async function setup(): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- test setup, not app config: the URL of the test cluster
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === "") return;
  await prepareTemplate(url);
}
