import { afterAll, beforeAll, beforeEach } from "vitest";
import { prepareDatabase, truncateAll } from "./database";

/**
 * Runs before each test file. The database is created and migrated once per
 * file and emptied before each test, so no test can pass because of a row
 * another one left behind.
 */
beforeAll(async () => {
  await prepareDatabase();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  const { closeDb } = await import("@scriptoria/db");
  await closeDb();
});
