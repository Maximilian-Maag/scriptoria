/**
 * FA-10.3 — which script a crontab line is about.
 *
 * A scheduled line has no row of its own (ADR-005: the crontab on the script VM
 * is the truth), so *which script does this line run* is answered by looking for
 * a catalogued script whose path the command refers to. That answer is what the
 * interface offers a *Run now* button on, so getting it wrong starts a script
 * nobody asked for.
 *
 * The reference has to match on a **path boundary**, not as a bare substring. A
 * directory holding `deploy.sh` beside `deploy.sh.in` — a `.in`, `.bak`, `.old`
 * or `.template` sibling, which is an ordinary thing to keep next to a script —
 * would otherwise attribute the line that runs `deploy.sh.in` to `deploy.sh`: a
 * substring match finds the shorter name first because the catalog is ordered by
 * file name and `deploy.sh` sorts before `deploy.sh.in`. *Run now* then starts
 * `deploy.sh`, and for a pair like that the two are rarely the same script.
 *
 * A shell word is delimited by whitespace, quotes, redirections and the other
 * punctuation a command line is built from, so the characters that may sit
 * immediately before and after the path are the ones that are *not* part of a
 * path. `/` is deliberately not one of them: the paths here are absolute and
 * begin with `/`, so a `/` on the left of a match means the match started in the
 * middle of some longer path, and rejecting it is right.
 */

/** A character that can appear inside a path, and so cannot bound one. */
const PATH_CHARACTER = /[A-Za-z0-9._-]/;

/**
 * Whether the shell command line `command` runs the script at `absolutePath`.
 *
 * Every occurrence of the path in the command is examined, so a command that
 * mentions it once inside a longer word and once as a whole word still matches
 * (the second occurrence is the one that counts).
 */
export function commandRunsScript(command: string, absolutePath: string): boolean {
  if (absolutePath === "") return false;

  let from = 0;
  for (;;) {
    const at = command.indexOf(absolutePath, from);
    if (at === -1) return false;

    const before = at === 0 ? "" : (command[at - 1] ?? "");
    const after = command[at + absolutePath.length] ?? "";
    if (!PATH_CHARACTER.test(before) && !PATH_CHARACTER.test(after)) return true;

    // Keep looking: this occurrence is inside a longer word, a later one may not
    // be. Starting past the match's first character is enough to make progress.
    from = at + 1;
  }
}
