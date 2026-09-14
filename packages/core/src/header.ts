import { criticalitySchema, type ScriptHeader } from "@scriptoria/contracts";

/**
 * ADR-004 — reads a script's self-declared metadata out of its header comment.
 *
 * Three rules govern this parser, and all three come from the same place: an
 * unreadable header must never keep a script out of the catalog.
 *
 *   1. It reads the first `MAX_HEADER_LINES` lines and stops. The productive
 *      scripts run 100 to 3000 lines and the body is none of our business.
 *   2. Every key is optional, every unknown key is kept rather than dropped.
 *   3. A malformed value is ignored, not fatal. A script with
 *      `scriptoria:criticality frobnicate` is a script with an undeclared criticality,
 *      which ADR-004 already has an answer for.
 */

export const MAX_HEADER_LINES = 100;

/** `# scriptoria:key   value` — the leading comment marker may be `#` or `//`. */
const KEY_LINE = /^\s*(?:#+|\/\/)\s*scriptoria:([a-z][a-z0-9_-]*)\s+(.*)$/i;

/**
 * A continuation line: a comment with no `scriptoria:` key, while a key is open. This
 * is what makes the multi-line `description` in ADR-004's example work.
 */
const CONTINUATION = /^\s*(?:#+|\/\/)\s{2,}(\S.*)$/;

/** Anything that is not a comment line ends the header block. */
const COMMENT_LINE = /^\s*(?:#|\/\/)/;

const TRUE_VALUES = new Set(["true", "yes", "1", "y", "on"]);
const FALSE_VALUES = new Set(["false", "no", "0", "n", "off"]);

/** A trailing `# read-only | modifying`-style comment is annotation, not value. */
function stripTrailingComment(value: string): string {
  const hash = value.indexOf(" #");
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

/**
 * Returns `null` when the file carries no `scriptoria:` block at all — which the
 * catalog renders as *undeclared*, not as an error.
 */
export function parseScriptHeader(source: string): ScriptHeader | null {
  const raw = new Map<string, string>();
  let openKey: string | null = null;

  const lines = source.split(/\r?\n/, MAX_HEADER_LINES);

  for (const line of lines) {
    const keyMatch = KEY_LINE.exec(line);
    if (keyMatch) {
      const key = (keyMatch[1] ?? "").toLowerCase();
      const value = stripTrailingComment(keyMatch[2] ?? "");
      // First declaration wins. A duplicated key is a mistake, and picking the
      // first one at least makes it a *consistent* mistake.
      if (!raw.has(key)) raw.set(key, value);
      openKey = key;
      continue;
    }

    const continuation = openKey === null ? null : CONTINUATION.exec(line);
    if (continuation && openKey !== null) {
      const previous = raw.get(openKey) ?? "";
      raw.set(openKey, `${previous} ${stripTrailingComment(continuation[1] ?? "")}`.trim());
      continue;
    }

    // A shebang or a blank line before the block does not end it; anything else
    // that is not a comment does.
    if (line.trim() === "" || line.startsWith("#!") || COMMENT_LINE.test(line)) {
      openKey = null;
      continue;
    }
    break;
  }

  if (raw.size === 0) return null;

  const known = ["title", "description", "criticality", "interactive", "outputs"] as const;
  const extra: Record<string, string> = {};
  for (const [key, value] of raw) {
    if (!(known as readonly string[]).includes(key)) extra[key] = value;
  }

  const header: ScriptHeader = { extra };

  const title = raw.get("title");
  if (title) header.title = title;

  const description = raw.get("description");
  if (description) header.description = description;

  const criticality = criticalitySchema.safeParse(raw.get("criticality")?.toLowerCase());
  if (criticality.success) header.criticality = criticality.data;

  const interactive = raw.get("interactive")?.toLowerCase();
  if (interactive !== undefined) {
    if (TRUE_VALUES.has(interactive)) header.interactive = true;
    else if (FALSE_VALUES.has(interactive)) header.interactive = false;
  }

  const outputs = raw.get("outputs");
  if (outputs && outputs.startsWith("/") && !outputs.split("/").includes("..")) {
    header.outputs = outputs;
  }

  return header;
}
