/**
 * FA-10.3 — which script a crontab line is about.
 *
 * A scheduled line has no row of its own (ADR-005: the crontab on the script VM
 * is the truth), so *which script does this line run* is answered by looking for
 * a catalogued script whose path the command refers to. That answer is what the
 * interface offers a *Run now* button on, so getting it wrong starts a script
 * nobody asked for.
 *
 * The reference has to match on a **shell word boundary**, not as a bare
 * substring. A directory holding `deploy.sh` beside `deploy.sh.in` — a `.in`,
 * `.bak`, `.old` or `.template` sibling, which is an ordinary thing to keep next
 * to a script — would otherwise attribute the line that runs `deploy.sh.in` to
 * `deploy.sh`: a substring match finds the shorter name first because the
 * catalog is ordered by file name and `deploy.sh` sorts before `deploy.sh.in`.
 * *Run now* then starts `deploy.sh`, and for a pair like that the two are rarely
 * the same script.
 *
 * The boundary is tested by naming what *ends* a shell word — whitespace, a
 * quote, a backtick, the shell's operators — and not by naming what a path may
 * contain. A file name is allowed to contain nearly anything (`+`, `%`, `=`), so
 * a list of path characters is a list that will one day be missing one; that is
 * how `deploy.sh+backup` was read as `deploy.sh`. A character that is not a
 * separator continues the same word, and so cannot bound a path.
 */

/** Characters that end a shell word: whitespace and the shell's own grammar. */
const WORD_SEPARATOR = /[\s;&|()<>'"`]/;

/** Whether the given position ends the word — an empty neighbour is an end. */
const endsWord = (character: string): boolean => character === "" || WORD_SEPARATOR.test(character);

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
    if (endsWord(before) && endsWord(after)) return true;

    // Keep looking: this occurrence is inside a longer word, a later one may not
    // be. Starting past the match's first character is enough to make progress.
    from = at + 1;
  }
}
