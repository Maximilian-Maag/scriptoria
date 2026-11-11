import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { backendSchema } from "./backend";
import { databaseSchema } from "./database";
import { frontendSchema } from "./frontend";
import { redisSchema } from "./redis";
import { runnerSchema } from "./runner";
import { sharedSchema } from "./shared";

/**
 * Every setting the code reads, against the files that are supposed to describe it.
 *
 * The two `.env` examples are documentation with no compiler: a key added to a schema and
 * not to them is a setting nobody can find, and a key renamed in one place is a file that
 * describes something the code no longer reads. Both failures are silent — the code has a
 * default, so nothing breaks, and the operator simply never learns the knob exists. This
 * repository already treats that shape as a bug worth a check: `schema.ts` is compared
 * with the migrations (`db-check`), and now the schemas are compared with the examples.
 *
 * **One direction only, deliberately.** Every key a schema reads must appear in each file
 * that documents it; keys a file carries that no schema reads are not reported, because
 * the deployment's file legitimately holds the container images' own bootstrap variables
 * (`POSTGRES_*`, `LDAP_*`) which no TypeScript in this repository reads. Checking that way
 * round would need a second list to maintain, and would fail on the honest case.
 *
 *     tsx src/checkEnvExample.ts        # or: make env-check
 */

interface Example {
  /** What an operator would call this file. */
  name: string;
  /** Relative to this file: packages/config/src → the repository root is three up. */
  path: string;
  /**
   * Keys this file may legitimately not carry, each with the reason. An exemption is a
   * sentence, not a name: a list of bare exceptions is how a check stops meaning anything.
   */
  exempt?: Record<string, string>;
}

const EXAMPLES: readonly Example[] = [
  {
    name: ".env.example (the dev stack)",
    path: "../../../.env.example",
  },
  {
    name: "infra/deploy/app.env.example (a deployment)",
    path: "../../../infra/deploy/app.env.example",
    exempt: {
      // Per-environment by construction: the frontend bundle is built with it, so it is a
      // build argument (`make docker-build-frontend TERMINAL_WS_URL=…`) and a runtime env
      // file could not change it. See ADR-007 and apps/frontend/Dockerfile.
      NEXT_PUBLIC_TERMINAL_WS_URL:
        "a build argument compiled into the frontend bundle, not a setting a host's env file can change",
    },
  },
];

/** The settings each schema reads, with the schemas named for the error message. */
const SCHEMAS: ReadonlyArray<[string, z.AnyZodObject]> = [
  ["shared", sharedSchema],
  ["redis", redisSchema],
  ["database", databaseSchema],
  ["backend", backendSchema],
  ["runner", runnerSchema],
  ["frontend", frontendSchema],
];

function keysOf(schema: z.AnyZodObject): string[] {
  return Object.keys(schema.shape);
}

/** `KEY=` at the start of a line; comments and blanks are prose, not settings. */
function keysIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) found.add(match[1]);
  }
  return found;
}

function main(): void {
  const settings = new Map<string, string[]>();
  for (const [schemaName, schema] of SCHEMAS) {
    for (const key of keysOf(schema)) {
      const readers = settings.get(key) ?? [];
      readers.push(schemaName);
      settings.set(key, readers);
    }
  }

  const all = [...settings.keys()].sort();
  const problems: string[] = [];

  for (const example of EXAMPLES) {
    const path = fileURLToPath(new URL(example.path, import.meta.url));
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      problems.push(`${example.name}: cannot be read at ${path}`);
      continue;
    }

    const present = keysIn(text);
    const missing = all.filter((key) => !present.has(key) && !(key in (example.exempt ?? {})));
    for (const key of missing) {
      const readers = settings.get(key)?.join(", ") ?? "?";
      problems.push(`${example.name}: ${key} is read by ${readers} and is not in this file`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`config: ${problem}`);
    console.error(
      `\nconfig: ${problems.length} setting(s) a schema reads are undocumented. Add them to the` +
        ` example file, or exempt them with the reason (see EXAMPLES in this file).`,
    );
    process.exit(1);
  }

  const exempt = EXAMPLES.flatMap((example) => Object.keys(example.exempt ?? {})).length;
  console.log(
    `  every one of ${all.length} settings is described by each example file` +
      (exempt > 0 ? ` (${exempt} documented exemption)` : ""),
  );
}

main();
