import { loadRunnerConfig } from "@scriptoria/config";

/**
 * Structured lines on stdout, for the log platform to pick up (NFR-05).
 *
 * Deliberately not a logging framework. This process has one output and one
 * format; a library would add a dependency, a configuration file and a plugin
 * system to produce the same line.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 } as const;
type Level = keyof typeof LEVELS;

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const config = loadRunnerConfig();
  if (LEVELS[level] < LEVELS[config.LOG_LEVEL]) return;

  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    service: config.SERVICE_NAME,
    component: "runner",
    message,
    ...fields,
  });

  // Anything at warn or above goes to stderr, so that a container's error
  // stream is the incident and its output stream is the history.
  if (LEVELS[level] >= LEVELS.warn) console.error(line);
  else process.stdout.write(`${line}\n`);
}

/** An Error is flattened here rather than at every call site. */
export const describeError = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

export const log = {
  trace: (message: string, fields?: Record<string, unknown>) => emit("trace", message, fields),
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
