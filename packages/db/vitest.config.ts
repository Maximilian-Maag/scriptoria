import { defineConfig } from "vitest/config";

/**
 * `packages/db` has no unit tests worth the name — its repositories need a
 * database — so there is nothing here that the default config would not do.
 * The one suite is the regression test for the schema drift check
 * (`test/checkSchemaDrift.test.ts`), which builds its own throwaway database
 * from the migrations and skips when there is no `DATABASE_URL` to build it
 * against. That skip is why CI runs it in the "Schema & migrations" job, which
 * has Postgres, rather than in the package test leg, which does not.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each case migrates a database of its own, so they are not independent of
    // the server but they are independent of each other; still give the slowest
    // (a fresh CREATE DATABASE plus the migrations) room to finish.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
