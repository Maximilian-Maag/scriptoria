import { defineConfig } from "vitest/config";

// Stryker copies the package into a sandbox, so the two test files that read artefacts from the
// repository root (infra/sshd/crontab, docs/guides/examples/reference-script.sh) cannot run there.
// Their subjects are excluded from mutation too, so no module is scored without its tests.
// This file exists only for a mutation run and is not part of the build.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/crontab.test.ts", "test/referenceScript.test.ts"],
    environment: "node",
  },
});
