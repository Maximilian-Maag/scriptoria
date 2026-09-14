import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads the repository's `.env` into `process.env`, if there is one.
 *
 * Called explicitly by each process's entrypoint rather than as a side effect of
 * importing this package. A module that mutates the environment when it is
 * imported makes the environment depend on import order, and import order is not
 * something anybody should have to reason about to explain a wrong database URL.
 *
 * Variables already set win: in a real deployment they come from the service
 * manager and its credential store, and a checked-out file must never override
 * them.
 */
export function loadEnvFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);

  // Walk up to the workspace root, so a process started from apps/backend and
  // one started from the repository root read the same file.
  for (let depth = 0; depth < 5; depth++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
