/**
 * ADR-005 — the crontab on the script VM is authoritative and the platform is a
 * guest in it.
 *
 * Everything here follows from one consequence in that ADR: *the platform
 * touches only the lines it manages and leaves everything else byte-for-byte
 * intact.* A read-modify-write that reformats a crontab is a read-modify-write
 * that will one day drop somebody's job, in an estate where a dropped job means
 * hundreds of systems did not get something they were supposed to.
 *
 * So: parsing is non-destructive — every line keeps its original text, and
 * rendering a parsed crontab that nobody edited returns the input unchanged,
 * which is the property the tests pin down.
 */

export const MANAGED_BEGIN = "# >>> scriptoria managed — do not edit inside this block by hand >>>";
export const MANAGED_END = "# <<< scriptoria managed <<<";

/** Nicknames cron accepts in place of the five fields. */
const NICKNAMES = new Set([
  "@reboot",
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly",
]);

export type CrontabLine =
  | { kind: "blank" | "comment"; raw: string }
  | { kind: "env"; raw: string; name: string; value: string }
  | {
      kind: "job";
      raw: string;
      /** The five fields, or the nickname, exactly as written. */
      expression: string;
      command: string;
      /** A job commented out with a single leading `#` is a disabled job. */
      enabled: boolean;
      /** Whether this line sits between the managed delimiters. */
      managed: boolean;
    };

const ENV_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * A cron field, properly: `*`, a number, a three-letter name, a range, a step,
 * or a comma-separated list of those.
 *
 * This grammar is not pedantry. Without it, `# hand-written, predates the
 * platform` uncomments into five-plus whitespace-separated tokens and gets read
 * as a disabled job — and the platform then offers to re-enable a sentence.
 */
const CRON_VALUE = String.raw`(?:\d{1,2}|[A-Za-z]{3})`;
const CRON_ELEMENT = String.raw`(?:\*|${CRON_VALUE}(?:-${CRON_VALUE})?)(?:\/\d{1,2})?`;
const CRON_FIELD = new RegExp(`^${CRON_ELEMENT}(?:,${CRON_ELEMENT})*$`);

function parseJob(text: string): { expression: string; command: string } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  if (trimmed.startsWith("@")) {
    const [nickname = "", ...rest] = trimmed.split(/\s+/);
    if (!NICKNAMES.has(nickname.toLowerCase()) || rest.length === 0) return null;
    return { expression: nickname, command: rest.join(" ") };
  }

  // Five whitespace-separated fields, then everything else verbatim. Splitting
  // and re-joining would collapse the spacing inside the command, and a command
  // is a shell line that is entitled to its own spacing.
  const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(trimmed);
  if (!match) return null;

  const fields = match.slice(1, 6);
  if (!fields.every((field) => CRON_FIELD.test(field))) return null;

  return { expression: fields.join(" "), command: match[6] as string };
}

export function parseCrontab(text: string): CrontabLine[] {
  const lines = text.split("\n");
  const result: CrontabLine[] = [];
  let inManagedBlock = false;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed === MANAGED_BEGIN.trim()) {
      inManagedBlock = true;
      result.push({ kind: "comment", raw });
      continue;
    }
    if (trimmed === MANAGED_END.trim()) {
      inManagedBlock = false;
      result.push({ kind: "comment", raw });
      continue;
    }

    if (trimmed === "") {
      result.push({ kind: "blank", raw });
      continue;
    }

    if (trimmed.startsWith("#")) {
      // A disabled job is a job, not a comment — otherwise re-enabling one
      // through the UI would mean the platform writing a line it never read.
      const uncommented = trimmed.replace(/^#+\s*/, "");
      const job = parseJob(uncommented);
      if (job) {
        result.push({ kind: "job", raw, ...job, enabled: false, managed: inManagedBlock });
      } else {
        result.push({ kind: "comment", raw });
      }
      continue;
    }

    const env = ENV_LINE.exec(raw);
    // `PATH=/usr/bin` is an assignment; `17 3 * * * cmd` is not, and the field
    // separator tells them apart before the regex gets a chance to be clever.
    if (env && !/^\s*[\d*@]/.test(raw)) {
      result.push({ kind: "env", raw, name: env[1] ?? "", value: env[2] ?? "" });
      continue;
    }

    const job = parseJob(raw);
    if (job) {
      result.push({ kind: "job", raw, ...job, enabled: true, managed: inManagedBlock });
    } else {
      result.push({ kind: "comment", raw });
    }
  }

  return result;
}

/** Byte-for-byte for anything nobody edited — that is the entire point. */
export function renderCrontab(lines: readonly CrontabLine[]): string {
  return lines.map((line) => line.raw).join("\n");
}

export interface ManagedEntry {
  expression: string;
  command: string;
  enabled: boolean;
}

function renderManagedEntry(entry: ManagedEntry): string {
  const line = `${entry.expression} ${entry.command}`;
  return entry.enabled ? line : `# ${line}`;
}

/**
 * Replaces the contents of the managed block and nothing else. If the file has
 * no managed block yet, one is appended — and the existing content still ends up
 * unchanged, which is checked by a test rather than hoped for.
 */
export function writeManagedBlock(text: string, entries: readonly ManagedEntry[]): string {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => l.trim() === MANAGED_BEGIN.trim());
  const end = lines.findIndex((l) => l.trim() === MANAGED_END.trim());

  const body = entries.map(renderManagedEntry);

  if (begin === -1) {
    // No block yet. Append one; every existing line survives, which is checked
    // by a test rather than hoped for.
    const trailingBlank = lines.at(-1) === "";
    const head = trailingBlank ? lines.slice(0, -1) : lines;
    return [...head, "", MANAGED_BEGIN, ...body, MANAGED_END, ""].join("\n");
  }

  // An opening delimiter with no closing one after it is a block the platform
  // started and did not finish — an interrupted write, or a hand-edit. Repair
  // it in place rather than appending a second one: `parseCrontab` reads
  // everything from here to the end of the file as managed, so those lines are
  // ours to replace, and appending would leave them where they are *and* write
  // the same jobs again below — a crontab that runs a job twice, which is the
  // mirror image of the failure ADR-005 exists to prevent.
  const closing = end > begin ? end : lines.length;
  const tail = closing === lines.length ? [MANAGED_END, ""] : lines.slice(closing);

  return [...lines.slice(0, begin + 1), ...body, ...tail].join("\n");
}

/** The jobs inside the managed block, in file order. */
export function managedJobs(lines: readonly CrontabLine[]): ManagedEntry[] {
  return lines
    .filter((l): l is Extract<CrontabLine, { kind: "job" }> => l.kind === "job" && l.managed)
    .map(({ expression, command, enabled }) => ({ expression, command, enabled }));
}
