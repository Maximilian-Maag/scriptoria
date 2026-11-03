import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * Deliberately self-contained: drizzle-kit loads this file through its own CJS
 * bundler, which cannot resolve the workspace packages' TypeScript source. So
 * this reads the one variable it needs directly rather than importing
 * @scriptoria/config and coupling a build tool to the application's wiring.
 *
 * The default is the same as the one in packages/config, and the .env file is
 * the same file. If they ever disagree, the app is right and this is wrong.
 */
const envFile = resolve(process.cwd(), "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5433/scriptoria",
  },
  strict: true,
  verbose: true,
});
