import { z } from "zod";
import { isoDateTimeSchema, remotePathSchema, uuidSchema } from "./common";

/**
 * Everything the control plane and the runner say to each other, and the Redis
 * key layout they say it over.
 *
 * The two processes never call each other directly — the runner listens on no
 * port (ADR-001 puts the SSH keys in one place and nothing else reaches it), so
 * every exchange is a key in Redis. That makes the key names a contract, and a
 * contract belongs here rather than in two files that are copies of each other
 * until the day one of them is edited.
 */

// ── Key layout ───────────────────────────────────────────────────────────────
// One namespace, so a `KEYS scriptoria:*` in an incident tells an operator
// everything this platform is holding.

export const redisKeys = {
  session: (id: string) => `scriptoria:session:${id}`,
  /**
   * Every session key at once, for the administrative sweep NFR-03 needs: a
   * mapping changed, and the sessions holding the old one have to be told.
   */
  sessionScan: "scriptoria:session:*",
  /** The capped stream of PTY bytes for one run (ADR-006). */
  runStream: (runId: string) => `scriptoria:run:${runId}:stream`,
  /** Keystrokes, published to whichever worker holds this run's PTY. */
  runStdin: (runId: string) => `scriptoria:run:${runId}:stdin`,
  /** Abort and resize, on the same route as stdin and for the same reason. */
  runControl: (runId: string) => `scriptoria:run:${runId}:control`,
  /** The job queue the runner's consumer blocks on. */
  runQueue: "scriptoria:runs:queue",
  /** Set by the worker that claimed a run, so a second one cannot. */
  runClaim: (runId: string) => `scriptoria:run:${runId}:claim`,
  /** Requests for the two things only the runner can do: read the script VM. */
  rpcRequests: "scriptoria:rpc:requests",
  /** One list per request, written by the runner and drained by the caller. */
  rpcReply: (requestId: string) => `scriptoria:rpc:reply:${requestId}`,
} as const;

// ── The run job ──────────────────────────────────────────────────────────────

/**
 * What the orchestrator puts on the queue: an id, and nothing else worth
 * disagreeing about. Every other fact — which host, which script, as whom —
 * is read from the run record, so the queue payload can never be a second,
 * staler description of the same run.
 */
export const runJobSchema = z.object({
  runId: uuidSchema,
  queuedAt: isoDateTimeSchema,
});
export type RunJob = z.infer<typeof runJobSchema>;

/**
 * Published on the run's control channel, which the worker holding the PTY is
 * subscribed to. Abort travels this way rather than as a database flag the
 * runner polls, because FA-08 is about stopping a script *now*.
 */
export const runControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("abort"),
    requestedBy: z.string(),
    at: isoDateTimeSchema,
  }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
]);
export type RunControl = z.infer<typeof runControlSchema>;

// ── The runner RPC ───────────────────────────────────────────────────────────

/** Where to connect. The credentials are not here: the runner holds those. */
export const sshTargetSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(64),
});
export type SshTarget = z.infer<typeof sshTargetSchema>;

/**
 * The two operations the control plane cannot perform itself.
 *
 * Both are reads of the script VM's filesystem, and both go through the runner
 * because ADR-001 puts the SSH key material in exactly one container. A control
 * plane that could read the script directory could also run something in it.
 */
export const rpcRequestSchema = z.discriminatedUnion("kind", [
  /** ADR-004: list a script directory and read each file's header block. */
  z.object({
    kind: z.literal("scan"),
    id: uuidSchema,
    target: sshTargetSchema,
    scriptPath: remotePathSchema,
  }),
  /** FA-09.1/9.2: list an output directory, optionally only what is new. */
  z.object({
    kind: z.literal("listFiles"),
    id: uuidSchema,
    target: sshTargetSchema,
    directory: remotePathSchema,
    /** Only files modified at or after this instant. Null lists everything. */
    since: isoDateTimeSchema.nullable(),
  }),
  /** FA-09.2/9.4: stream one result file back, capped. */
  z.object({
    kind: z.literal("readFile"),
    id: uuidSchema,
    target: sshTargetSchema,
    path: remotePathSchema,
    maxBytes: z.number().int().min(1).max(1_073_741_824),
  }),
]);
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

/** One entry of a scan: what ADR-004's parser found in one file. */
export const scannedScriptSchema = z.object({
  fileName: z.string().min(1).max(255),
  absolutePath: remotePathSchema,
  sizeBytes: z.number().int().min(0),
  modifiedAt: isoDateTimeSchema.nullable(),
  /** Null when the file carries no readable block — never a reason to hide it. */
  header: z.record(z.unknown()).nullable(),
  /** Whether the file's mode says it can be started on its own shebang. */
  executable: z.boolean(),
});
export type ScannedScriptPayload = z.infer<typeof scannedScriptSchema>;

export const scanResultSchema = z.object({
  scripts: z.array(scannedScriptSchema),
});
export type ScanResult = z.infer<typeof scanResultSchema>;

export const listedFileSchema = z.object({
  /** Relative to the directory that was listed. */
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0),
  modifiedAt: isoDateTimeSchema,
});
export type ListedFile = z.infer<typeof listedFileSchema>;

export const listFilesResultSchema = z.object({
  files: z.array(listedFileSchema),
  /** True when the listing hit its own ceiling and stopped early. */
  truncated: z.boolean(),
});
export type ListFilesResult = z.infer<typeof listFilesResultSchema>;

export const readFileHeaderSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int().min(0),
  /** True when the file was longer than `maxBytes` and the stream stops early. */
  truncated: z.boolean(),
});
export type ReadFileHeader = z.infer<typeof readFileHeaderSchema>;

/**
 * Reply framing. Every frame is one Redis list entry whose first byte says what
 * it is, so a JSON envelope and a megabyte of result file can travel the same
 * list without either being escaped into the other.
 *
 *   0x01  JSON payload — the answer, or the header of a file stream
 *   0x02  a chunk of file bytes, raw
 *   0x00  end of reply
 *   0x7f  JSON `{ code, message }`; the request did not succeed
 */
export const RPC_FRAME = {
  JSON: 0x01,
  CHUNK: 0x02,
  END: 0x00,
  ERROR: 0x7f,
} as const;

export const rpcErrorSchema = z.object({
  code: z.enum(["not_found", "forbidden", "upstream_unavailable", "timeout", "internal"]),
  message: z.string(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;
