/**
 * How a script is started on the script VM, and how it is signalled afterwards.
 *
 * This is pure string building, kept out of the runner so that the two commands
 * the platform is trusted to run on a hardened VM can be read, reviewed and
 * tested without an SSH connection anywhere near them.
 *
 * Two decisions are encoded here, and both come from ADR-001 and ADR-003:
 *
 *   · The script is started with `exec`, so that the shell sshd spawned *becomes*
 *     the script. That shell is the session leader of the PTY, so its pid is
 *     also the process group id — which is the id ADR-003 needs, because
 *     signalling the channel reaches the shell at best and the SSH server
 *     commonly ignores the request altogether.
 *   · The pid is written to a file before the exec rather than printed. Printing
 *     it would put bytes on the terminal that the operator never typed and the
 *     script never wrote, and the runner would have to strip them back out of a
 *     byte stream whose whole point is that it is not parsed.
 */

/** The directory the pid files live in on the script VM. One per run. */
export const PID_DIR = "/tmp/.scriptoria";

export const pidFilePath = (runId: string): string => `${PID_DIR}/${runId}.pid`;

/**
 * POSIX single-quoting. Every path in these commands is either admin-configured
 * or a file name read off the VM, so none of it is attacker-controlled in the
 * usual sense — but a directory with a space in it is not exotic, and a quoting
 * bug here is a command that runs something other than what it says.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const INTERPRETERS: Record<string, string> = {
  py: "python3",
  pl: "perl",
  rb: "ruby",
  ksh: "ksh",
  zsh: "zsh",
};

/**
 * `bash` rather than `sh`, and a `.sh` file gets it too.
 *
 * The extension says "shell"; the shebang of every shell script in the estate
 * says bash, and on a Debian-family VM `/bin/sh` is dash. Guessing dash for a
 * script written for bash fails as a syntax error partway through, which is the
 * worst moment for a guess to be wrong. bash runs both.
 */
const DEFAULT_INTERPRETER = "bash";

/**
 * Which interpreter to name when the file cannot start itself.
 *
 * An executable file is run directly, on its own shebang — that is the script
 * owner's declaration of what it needs (NFR-06, NFR-07), and second-guessing it
 * would be the platform having an opinion about a runtime it does not own. This
 * only answers the other case: a file with the executable bit missing, where
 * refusing to start it would be a worse answer than reading its extension.
 */
export function interpreterFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_INTERPRETER;
  return INTERPRETERS[fileName.slice(dot + 1).toLowerCase()] ?? DEFAULT_INTERPRETER;
}

export interface ExecutionCommandInput {
  runId: string;
  /** The script, as the scanner found it. */
  absolutePath: string;
  fileName: string;
  /** The mapped script directory. The script's own cwd, so relative paths work. */
  workingDirectory: string;
  /** False when the executable bit is missing and an interpreter has to be named. */
  executable: boolean;
}

/**
 * The command handed to the PTY channel.
 *
 * `cd` into the script's own directory first: FA-05.3 asks for a defined service
 * context, and the scripts that create their own directories and configuration
 * files (NFR-21) do it relative to where they are.
 */
export function executionCommand(input: ExecutionCommandInput): string {
  const pidFile = pidFilePath(input.runId);
  const target = input.executable
    ? shellQuote(input.absolutePath)
    : `${interpreterFor(input.fileName)} ${shellQuote(input.absolutePath)}`;

  return [
    `mkdir -p ${shellQuote(PID_DIR)}`,
    `printf '%s' "$$" > ${shellQuote(pidFile)}`,
    `cd ${shellQuote(input.workingDirectory)}`,
    `exec ${target}`,
  ].join(" && ");
}

/**
 * ADR-003's signal, sent down a second exec channel on the same connection.
 *
 * The minus sign is the entire point: it signals the process *group*, so a
 * script that spawned ssh, curl and three subshells stops rather than leaving
 * its children behind attached to nothing.
 */
export function abortCommand(runId: string, signal: "INT" | "TERM" | "KILL"): string {
  const pidFile = shellQuote(pidFilePath(runId));
  return `pid=$(cat ${pidFile} 2>/dev/null) && [ -n "$pid" ] && kill -${signal} "-$pid"`;
}

/** Run once the process is gone, so /tmp does not accumulate a file per run. */
export function cleanupCommand(runId: string): string {
  return `rm -f ${shellQuote(pidFilePath(runId))}`;
}
