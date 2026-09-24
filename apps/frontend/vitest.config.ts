import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The interface's unit tests.
 *
 * Most run in Node like every other package's, and the components run on jsdom
 * — a file that renders React asks for it with `// @vitest-environment jsdom`,
 * so the proxy and address tests keep a real HTTP server and a real socket.
 *
 * Two things they need that a bare config does not give them. The first is `@/`
 * — the alias Next resolves to `src/` (see `tsconfig.json`) and that every
 * component in this application imports through. Without it a test can import
 * only modules that import nothing themselves.
 *
 * The second is the JSX runtime. Next compiles the components with React's
 * *automatic* runtime, so none of them imports React to get `createElement`;
 * esbuild has nothing to go on in `tsconfig.json` either, because `jsx` is
 * `preserve` for Next's own benefit. Left to itself esbuild falls back to the
 * classic runtime and the first test that renders a component fails with
 * "React is not defined".
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  esbuild: { jsx: "automatic" },
});
