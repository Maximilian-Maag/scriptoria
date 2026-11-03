import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // A database-backed test is not a unit test: the suite creates its own
    // database, and two files truncating the same tables in parallel would
    // fail each other rather than the code.
    fileParallelism: false,
    // The database lifecycle is not a global setup file. Most of this suite is
    // unit tests whose repositories are mocked — several replace the whole of
    // `@scriptoria/db` — and a global setup that opens a real connection and
    // truncates tables would run for those too, and fail on the mock it finds
    // there. The one file that needs a database imports `./support/setup`
    // itself, so the fixture it uses and the schema it migrates stay that
    // file's business.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
  resolve: {
    // The same alias `tsconfig.json` gives the application, so a test imports a
    // service by the path the service's own neighbours use.
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
});
