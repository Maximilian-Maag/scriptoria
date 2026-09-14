import { z } from "zod";

/**
 * Environment loading, in one place, with one rule: a process that is missing
 * configuration must fail on startup and say everything that is wrong at once.
 *
 * The alternative — `process.env.X!` scattered through the code — fails on the
 * first request that happens to touch the missing variable, in an isolated
 * environment where nobody can attach a debugger. This costs a few lines and buys a startup
 * error that a colleague can act on without reading the source.
 */

export class ConfigError extends Error {
  constructor(
    readonly scope: string,
    readonly issues: readonly string[],
  ) {
    super(
      `Invalid ${scope} configuration:\n` +
        issues.map((i) => `  · ${i}`).join("\n") +
        `\n\nSee .env.example for what each variable is for.`,
    );
    this.name = "ConfigError";
  }
}

/**
 * Parses `source` against `schema` and caches the result, so a module that reads
 * the config on every call still pays for the validation once. The cache is
 * keyed on the loader, not on the environment: a process does not get a new
 * environment while it runs.
 */
export function defineConfig<S extends z.ZodTypeAny>(
  scope: string,
  schema: S,
): () => Readonly<z.infer<S>> {
  let cached: z.infer<S> | undefined;

  return () => {
    if (cached === undefined) {
      const result = schema.safeParse(process.env);
      if (!result.success) {
        throw new ConfigError(
          scope,
          result.error.issues.map((issue) => {
            const path = issue.path.join(".");
            return path ? `${path}: ${issue.message}` : issue.message;
          }),
        );
      }
      cached = result.data;
    }
    return cached as Readonly<z.infer<S>>;
  };
}

/** An integer from the environment, where everything arrives as a string. */
export const intFromEnv = (opts?: { min?: number; max?: number }) =>
  z.coerce.number().int().min(opts?.min ?? 0).max(opts?.max ?? Number.MAX_SAFE_INTEGER);

/** `true`/`1`/`yes` — anything else is false. Environment booleans are strings. */
export const boolFromEnv = z
  .string()
  .transform((v) => ["true", "1", "yes", "on"].includes(v.trim().toLowerCase()));

export const nonEmpty = z.string().trim().min(1);
