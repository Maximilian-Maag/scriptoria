import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The backend's unit tests, which run in Node like every other package's.
 *
 * The one thing they need that a bare config does not give them is `@/` — the
 * alias the backend's `tsconfig.json` defines and that every route handler and
 * service imports through. Vitest resolves modules with Vite, which does not
 * read tsconfig `paths`, so without this a test could only import modules that
 * import nothing themselves — and the route handlers, where the HTTP contract
 * lives, would be the one layer that cannot be tested.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
