import { posix } from "node:path";
import ssh2, { Client, type ClientChannel, type FileEntryWithStats, type SFTPWrapper } from "ssh2";
import { loadRunnerConfig } from "@scriptoria/config";
import type { AbortStage } from "@scriptoria/contracts";
import {
  CRONTAB_READ_COMMAND,
  CRONTAB_WRITE_COMMAND,
  abortCommand,
  cleanupCommand,
  executionCommand,
} from "@scriptoria/core";
import { hostKeyVerifier, loadCredentials } from "../ssh/credentials";
import { describeError, log } from "../log";
import type {
  DirectoryEntry,
  ExecutionTarget,
  FileFacts,
  ListOptions,
  Listing,
  ProcessExit,
  ReadResult,
  RunningScript,
  StartSpec,
  TargetAddress,
} from "./executionTarget";

/**
 * `ssh2` is CommonJS, and Node's ESM loader publishes only the exports its
 * lexer can see: `Client` is one of them, `utils` is not.
 *
 * On Node 22 — the version CI pins — the named import therefore kills the runner
 * at import time, before it registers with anything:
 *
 *   SyntaxError: The requested module 'ssh2' does not provide an export named 'utils'
 *
 * and the runner then looks like a worker that never started, which every
 * request that needs the catalog reports as a 30-second timeout. A developer's
 * newer Node resolves the named import and hides this completely, and so does
 * the test suite, where vitest's own CommonJS interop stands in for the loader.
 * Reading it off the module object is the form that works everywhere.
 */
const { utils } = ssh2;

/**
 * ADR-001's implementation: outbound SSH, a PTY for the run, SFTP for the
 * results, all on one connection.
 *
 * One of these is one connection to one script VM. A run holds it for as long
 * as the script lives, which is the reason the runner is its own process: a web
 * process that held these would kill every running script on every deploy.
 */

const SIGNALS: Record<AbortStage, "INT" | "TERM" | "KILL"> = {
  sigint: "INT",
  sigterm: "TERM",
  sigkill: "KILL",
};

/** Listing ceilings. A result set of 800 files is normal; 100 000 is a mistake. */
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_DEPTH = 8;

export class SshExecutionTarget implements ExecutionTarget {
  private sftpWrapper: SFTPWrapper | undefined;
  private closed = false;

  /**
   * The client is a parameter rather than a field initialiser because this class
   * is where the runner meets ssh2's event ordering, and the ordering is worth a
   * test with a peer whose timing is known rather than a real one's.
   */
  constructor(
    readonly address: TargetAddress,
    private readonly client: Client = new Client(),
  ) {}

  connect(): Promise<void> {
    const config = loadRunnerConfig();
    const credentials = loadCredentials();

    return new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        this.client.off("error", onError);
        // From here an error is an incident rather than a failed connection
        // attempt: without this listener Node would turn a dropped TCP socket
        // into an unhandled 'error' event and take the worker down with it.
        this.client.on("error", (cause) => {
          log.warn("ssh connection error", { ...this.address, error: describeError(cause) });
        });
        resolve();
      };
      const onError = (cause: Error): void => {
        this.client.off("ready", onReady);
        reject(cause);
      };

      this.client.once("ready", onReady).once("error", onError);

      this.client.connect({
        host: this.address.host,
        port: this.address.port,
        username: this.address.username,
        privateKey: credentials.privateKey,
        ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
        readyTimeout: config.SSH_CONNECT_TIMEOUT_MS,
        keepaliveInterval: config.SSH_KEEPALIVE_INTERVAL_MS,
        // ADR-001: the host key is pinned per script VM.
        hostVerifier: hostKeyVerifier(this.address.host, this.address.port),
      });
    });
  }

  /**
   * Opens the PTY and starts the script in it.
   *
   * The command is built in `@scriptoria/core` rather than here, because what
   * the platform runs on a hardened VM is worth reading in one place and
   * testing without a network.
   */
  async start(spec: StartSpec): Promise<RunningScript> {
    const command = executionCommand({
      runId: spec.runId,
      absolutePath: spec.absolutePath,
      fileName: spec.fileName,
      workingDirectory: spec.workingDirectory,
      executable: spec.executable,
    });

    // Everything that listens on the channel is attached *inside* the exec
    // callback, before this function gets control back. ssh2 emits `exit` from
    // its packet parser: a peer that confirms the channel and reports the exit
    // without waiting for us delivers the event before the continuation of an
    // `await` on this promise runs. Attached afterwards — as this was — an exit
    // that arrived in that window was never seen, `exit.code` stayed null, and a
    // run that exited 0 was audited as `failed` with reason `exit_code`
    // (FA-10.2, FA-12.2). The two private helpers below have always done it this
    // way; `start` was the exception.
    const { channel, finished } = await new Promise<{
      channel: ClientChannel;
      finished: Promise<ProcessExit>;
    }>((resolve, reject) => {
      this.client.exec(
        command,
        {
          pty: {
            cols: spec.cols,
            rows: spec.rows,
            // The scripts emit colour and cursor movement, and xterm.js renders
            // it. Announcing a terminal that cannot is how a dialogue ends up
            // looking like garbage in the one place the product exists for.
            term: "xterm-256color",
          },
        },
        (error, stream) => {
          if (error) {
            reject(error);
            return;
          }

          // A channel that errors after the process has gone must not be able
          // to end the worker (see `read`).
          stream.on("error", (cause: unknown) => {
            log.debug("terminal channel error", { runId: spec.runId, error: describeError(cause) });
          });
          stream.stderr.on("error", () => {});

          let exit: ProcessExit = { code: null, signal: null };
          stream.on("exit", (code: number | null, signal?: string) => {
            exit = { code: typeof code === "number" ? code : null, signal: signal ?? null };
          });

          const settled = new Promise<ProcessExit>((resolveExit) => {
            stream.once("close", () => resolveExit(exit));
          });

          resolve({ channel: stream, finished: settled });
        },
      );
    });

    return {
      onData: (listener) => {
        channel.on("data", listener);
        // With a PTY, stderr is usually already merged into the same stream.
        // "Usually" is not "always", and output the operator cannot see is the
        // one thing FA-07 cannot tolerate.
        channel.stderr.on("data", listener);
      },
      write: (data) => {
        channel.write(Buffer.from(data));
      },
      resize: (cols, rows) => {
        channel.setWindow(rows, cols, 0, 0);
      },
      signal: async (stage) => {
        // A second channel, not `channel.signal()`: an OpenSSH server commonly
        // ignores the channel signal message, and even when it does not, the
        // signal reaches the shell rather than the process group (ADR-003).
        await this.exec(abortCommand(spec.runId, SIGNALS[stage]));
      },
      exit: finished,
    };
  }

  /**
   * The executable bit is read here rather than taken from the catalog, because
   * whether a script can start itself is a fact about the file right now — and
   * the catalog is a cache of what it looked like at the last scan.
   *
   * `null` means the path is not there, and nothing else. Every other failure —
   * a permission the service account lacks, a connection that went away
   * mid-request — is a read that failed, and is reported as one. Answering
   * `null` for those is what turned an existing result file into a `not_found`
   * for the operator (FA-09.2) and a script that is on the VM into one that had
   * "gone" (FA-03.3).
   */
  async stat(path: string): Promise<FileFacts | null> {
    const sftp = await this.sftp();
    return new Promise<FileFacts | null>((resolve, reject) => {
      sftp.stat(path, (error, stats) => {
        if (error) {
          if (isMissing(error)) resolve(null);
          else reject(error);
          return;
        }
        resolve({
          sizeBytes: stats.size,
          modifiedAt: new Date(stats.mtime * 1000),
          executable: (stats.mode & 0o111) !== 0,
        });
      });
    });
  }

  async list(directory: string, options: ListOptions = {}): Promise<Listing> {
    const sftp = await this.sftp();
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const since = options.since ?? null;

    const entries: DirectoryEntry[] = [];
    let truncated = false;

    /** One directory read. A rejection when the server would not give it. */
    const readDirectory = (absolute: string): Promise<FileEntryWithStats[]> =>
      new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(absolute, (error, list) => (error ? reject(error) : resolve(list)));
      });

    const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
      if (truncated) return;

      // No catch here, and deliberately so: at depth 0 this is the read the
      // caller asked for. Answering `[]` for a directory the account could not
      // read is how one bad SFTP read came back as "this area has no scripts"
      // and emptied the catalogue (FA-03.3, FA-09.1) — the caller cannot tell a
      // failed read from a directory that is genuinely empty, and the control
      // plane believes `[]`.
      const listed = await readDirectory(absolute);

      for (const item of listed) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }

        const childAbsolute = posix.join(absolute, item.filename);
        const childRelative = relative === "" ? item.filename : `${relative}/${item.filename}`;
        const attrs = item.attrs;

        if (attrs.isDirectory()) {
          if (depth < maxDepth) {
            try {
              await walk(childAbsolute, childRelative, depth + 1);
            } catch (cause) {
              // A subdirectory *within* the walk is a different thing: a
              // date-stamped result folder the account cannot read is a fact
              // about the VM, not a failure of the listing, and the rest of the
              // result set is still worth having — the result has to be visible
              // even for a run that failed (FA-09.5).
              log.debug("could not read a subdirectory", {
                path: childAbsolute,
                error: describeError(cause),
              });
            }
          }
          continue;
        }
        if (!attrs.isFile()) continue;

        const modifiedAt = new Date(attrs.mtime * 1000);
        if (since && modifiedAt < since) continue;

        entries.push({
          path: childRelative,
          name: item.filename,
          sizeBytes: attrs.size,
          modifiedAt,
          executable: (attrs.mode & 0o111) !== 0,
        });
      }
    };

    await walk(directory, "", 0);
    return { entries, truncated };
  }

  async readHead(path: string, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.read(path, maxBytes, async (chunk) => {
      chunks.push(chunk);
    });
    return Buffer.concat(chunks);
  }

  /**
   * Streams a file out in chunks, awaiting the consumer on each one.
   *
   * Awaiting is what makes this safe for a result file of any size: the SFTP
   * stream stops being read while the consumer is busy, so a 2 GB file does not
   * become 2 GB of runner memory.
   */
  async read(
    path: string,
    maxBytes: number,
    onChunk: (chunk: Buffer) => Promise<void>,
  ): Promise<ReadResult> {
    const sftp = await this.sftp();
    const stream = sftp.createReadStream(path);

    // ssh2 emits `error` on a read stream when the channel closes underneath
    // it — including when this target is closed straight after a successful
    // read. An `error` event with no listener is fatal to the whole process in
    // Node, so this listener is not tidiness: without it, finishing a download
    // kills every PTY the worker is holding.
    stream.on("error", (cause: unknown) => {
      log.debug("sftp read stream ended with an error", {
        path,
        error: describeError(cause),
      });
    });

    let sizeBytes = 0;
    let truncated = false;

    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        const remaining = maxBytes - sizeBytes;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        sizeBytes += slice.length;
        await onChunk(slice);
        if (slice.length < chunk.length) {
          truncated = true;
          break;
        }
      }
    } finally {
      stream.destroy();
    }

    return { sizeBytes, truncated };
  }

  /**
   * ADR-005. `crontab -l` exits non-zero when the account has no crontab, and
   * that is the ordinary "nothing scheduled here yet" answer rather than a
   * failure — told apart from a real error by whether anything came back on
   * stderr, because the exit code alone cannot distinguish them.
   */
  async readCrontab(): Promise<string | null> {
    const result = await this.execCapture(CRONTAB_READ_COMMAND);
    if (result.code === 0) return result.stdout;

    if (/no crontab for/i.test(result.stderr)) return null;
    throw new Error(
      result.stderr.trim() === ""
        ? `reading the crontab exited with ${result.code}`
        : `reading the crontab failed: ${result.stderr.trim()}`,
    );
  }

  /**
   * The whole file, on stdin, in one write.
   *
   * `crontab -` replaces the crontab atomically or not at all: it parses what
   * it is given and installs nothing if the parse fails. That is the property
   * this depends on — a half-written crontab is a set of jobs that silently
   * stop happening.
   */
  async writeCrontab(text: string): Promise<void> {
    const result = await this.execCapture(CRONTAB_WRITE_COMMAND, text);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() === ""
          ? `writing the crontab exited with ${result.code}`
          : `writing the crontab failed: ${result.stderr.trim()}`,
      );
    }
  }

  async cleanup(runId: string): Promise<void> {
    try {
      await this.exec(cleanupCommand(runId));
    } catch (cause) {
      // The pid file is a temporary file on someone else's machine. Failing a
      // finished run because it is still there would be absurd.
      log.debug("could not remove the pid file", { runId, error: describeError(cause) });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.client.end();
  }

  /** A command with no terminal: abort signals and cleanup, and nothing else. */
  private exec(command: string): Promise<number | null> {
    return new Promise<number | null>((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let code: number | null = null;
        stream.on("error", () => {});
        stream.stderr.on("error", () => {});
        stream.on("exit", (value: number | null) => {
          code = typeof value === "number" ? value : null;
        });
        stream.on("close", () => resolve(code));
        stream.resume();
        stream.stderr.resume();
      });
    });
  }

  /**
   * A command whose output is the answer, optionally fed something on stdin.
   *
   * Separate from `exec` above, which throws its output away because a signal
   * and an `rm` have nothing to say. A crontab is entirely what it prints, and
   * stderr is how cron explains a refusal, so both are captured.
   *
   * Bounded: a crontab is a small text file and anything claiming to be a
   * hundred megabytes of one is a symptom, not a schedule.
   */
  private execCapture(
    command: string,
    stdin?: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const MAX_OUTPUT_BYTES = 1024 * 1024;

    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        let outBytes = 0;
        let code: number | null = null;

        stream.on("error", reject);
        stream.stderr.on("error", reject);

        stream.on("data", (chunk: Buffer) => {
          outBytes += chunk.length;
          if (outBytes > MAX_OUTPUT_BYTES) {
            stream.destroy();
            reject(new Error("the command produced more output than a crontab could be"));
            return;
          }
          out.push(chunk);
        });
        stream.stderr.on("data", (chunk: Buffer) => errOut.push(chunk));

        stream.on("exit", (value: number | null) => {
          code = typeof value === "number" ? value : null;
        });
        stream.on("close", () => {
          resolve({
            code,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(errOut).toString("utf8"),
          });
        });

        if (stdin !== undefined) {
          stream.end(stdin);
        }
      });
    });
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpWrapper) return Promise.resolve(this.sftpWrapper);
    return new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((error, wrapper) => {
        if (error) {
          reject(error);
          return;
        }
        this.sftpWrapper = wrapper;
        resolve(wrapper);
      });
    });
  }
}

/**
 * Whether the SFTP server said "not there" rather than "I could not read it".
 *
 * ssh2 puts the SSH_FX status code on the error, and only NO_SUCH_FILE means the
 * path is absent. Everything else — PERMISSION_DENIED, CONNECTION_LOST, a
 * request against a dead channel — is a read that failed and must be reported as
 * one, or an existing file is answered as a missing one.
 */
function isMissing(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return code === utils.sftp.STATUS_CODE.NO_SUCH_FILE || code === "ENOENT";
}

/** Opens a connection and hands it over ready to use. */
export async function connectTo(address: TargetAddress): Promise<ExecutionTarget> {
  const target = new SshExecutionTarget(address);
  await target.connect();
  return target;
}
