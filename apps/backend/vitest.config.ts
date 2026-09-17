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
    // Creates and migrates the test database, and empties it between tests.
    setupFiles: ["./test/support/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
  resolve: {
    // The same alias `tsconfig.json` gives the application, so a test imports a
    // service by the path the service's own neighbours use.
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
});
