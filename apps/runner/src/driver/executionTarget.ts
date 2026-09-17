import type { AbortStage } from "@scriptoria/contracts";

/**
 * ADR-001's seam.
 *
 * SSH with a PTY was chosen over an agent on every script VM, and the decision
 * records its own escape hatch: "the runner is written against an
 * `ExecutionTarget` interface — if an agent is ever needed, it is a new
 * implementation of that interface and nothing above it changes."
 *
 * This is that interface. Everything above it — the job consumer, the run
 * lifecycle, the stream publisher, the collector — is written in terms of these
 * six operations and knows nothing about ssh2, channels or SFTP.
 *
 * It is deliberately small, and every operation on it is one the *platform*
 * needs rather than one SSH happens to offer. Nothing here can execute an
 * arbitrary command: a target starts a script that an administrator mapped and
 * signals the one it started, and that is the whole vocabulary.
 */

export interface TargetAddress {
  host: string;
  port: number;
  username: string;
}

export interface StartSpec {
  runId: string;
  absolutePath: string;
  fileName: string;
  workingDirectory: string;
  executable: boolean;
  cols: number;
  rows: number;
}

export interface ProcessExit {
  /** Null when the process was signalled rather than exited. */
  code: number | null;
  signal: string | null;
}

/**
 * A live process on the target, seen through its terminal.
 *
 * `data` hands over the bytes exactly as they came off the PTY. They are never
 * decoded here and never should be: a read boundary falls wherever the kernel
 * puts it, routinely mid-character (ADR-006).
 */
export interface RunningScript {
  onData(listener: (chunk: Buffer) => void): void;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** One stage of ADR-003's escalation. Resolves once the signal has been sent. */
  signal(stage: AbortStage): Promise<void>;
  /** Resolves when the process is gone, however it went. */
  readonly exit: Promise<ProcessExit>;
}

export interface DirectoryEntry {
  /** Relative to the directory that was listed. */
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: Date;
  /** Whether the file can start itself on its own shebang. */
  executable: boolean;
}

export interface ListOptions {
  /** Only entries modified at or after this instant. */
  since?: Date | null;
  /** How deep to descend. Scripts are flat; results are date-stamped folders. */
  maxDepth?: number;
  maxEntries?: number;
}

export interface Listing {
  entries: DirectoryEntry[];
  /** True when `maxEntries` was reached and the listing stopped early. */
  truncated: boolean;
}

export interface ReadResult {
  sizeBytes: number;
  truncated: boolean;
}

export interface FileFacts {
  sizeBytes: number;
  modifiedAt: Date;
  /** Whether the file can start itself on its own shebang. */
  executable: boolean;
}

export interface ExecutionTarget {
  readonly address: TargetAddress;

  connect(): Promise<void>;

  /** Null when the path is not there. Read fresh, never from the catalog cache. */
  stat(path: string): Promise<FileFacts | null>;

  /** Starts the script on a PTY, in its own process group (ADR-003). */
  start(spec: StartSpec): Promise<RunningScript>;

  list(directory: string, options?: ListOptions): Promise<Listing>;

  /** The first bytes of a file — ADR-004's header block, never the body. */
  readHead(path: string, maxBytes: number): Promise<Buffer>;

  /** Streams a result file out, chunk by chunk, so a large one is not buffered. */
  read(path: string, maxBytes: number, onChunk: (chunk: Buffer) => Promise<void>): Promise<ReadResult>;

  /** Best effort, after the process is gone. Never a reason to fail a run. */
  cleanup(runId: string): Promise<void>;

  close(): void;
}
