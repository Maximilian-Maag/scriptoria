import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The interface's unit tests, which run in Node like every other package's.
 *
 * The one thing they need that a bare config does not give them is `@/` — the
 * alias Next resolves to `src/` (see `tsconfig.json`) and that every component
 * in this application imports through. Without it a test can import only
 * modules that import nothing themselves, which is why these tests stopped at
 * `src/lib/` and the components went uncovered.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
