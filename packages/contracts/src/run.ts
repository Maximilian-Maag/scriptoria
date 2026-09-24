import { z } from "zod";
import { criticalitySchema } from "./script";

/**
 * The run state machine. `aborted` is deliberately distinct from `failed`:
 * ADR-003 needs the distinction for the audit trail, and FA-10.2 needs it for
 * *last successful*.
 */
export const runStatusSchema = z.enum([
  /** Accepted and on the queue. No worker has claimed it. */
  "queued",
  /** A worker claimed it and is opening the SSH connection. */
  "starting",
  /** The PTY is live. The only state in which stdin is accepted. */
  "running",
  /** Exited 0. */
  "succeeded",
  /** Exited non-zero, or the connection died under it. */
  "failed",
  /** A human stopped it (FA-08). Not a failure — a decision. */
  "aborted",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "aborted",
] as const satisfies readonly RunStatus[];

export const isTerminalStatus = (status: RunStatus): boolean =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/**
 * The other half of the classification, named here for the same reason: the two
 * lists are the state machine, and the console chooses between watching a run
 * on a socket and reading it back from its transcript on the strength of them
 * (FA-07.2). A list kept privately in the interface is a second copy of a
 * shared rule, and the two are allowed to disagree only if nobody is looking.
 */
export const LIVE_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
] as const satisfies readonly RunStatus[];

export const isLiveStatus = (status: RunStatus): boolean =>
  (LIVE_RUN_STATUSES as readonly string[]).includes(status);

/** Why a run reached a terminal state, when the exit code alone does not say. */
export const runFailureReasonSchema = z.enum([
  "exit_code",
  "connection_lost",
  "connect_failed",
  "start_failed",
  "worker_lost",
  "aborted_by_user",
]);
export type RunFailureReason = z.infer<typeof runFailureReasonSchema>;

/**
 * FA-05.5: there is no parametrisation before the start. Either the parameter
 * set is fixed in the code, or it is asked for through dialogue after the start.
 * So a start request carries a script and nothing else.
 *
 * The PTY size is not a parameter of the script — it is a property of the
 * terminal the user is looking at, and a script that formats a table needs it to
 * be honest.
 */
export const startRunRequestSchema = z.object({
  scriptId: z.string().uuid(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

/** How the run came to exist. Cron runs are observed, not started (ADR-005). */
export const runTriggerSchema = z.enum(["manual", "scheduled"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

export const runSchema = z.object({
  id: z.string().uuid(),
  areaId: z.string().uuid(),
  scriptId: z.string().uuid(),

  /** Denormalised so a run list does not need the catalog to be renderable. */
  scriptFileName: z.string(),
  scriptTitle: z.string(),
  /** The criticality *as it was at start time*. A later override must not rewrite history. */
  criticality: criticalitySchema,

  status: runStatusSchema,
  trigger: runTriggerSchema,

  /** The AD account that started it. FA-12.1. */
  startedBy: z.string(),

  /** Which VM it ran on, recorded because "where" is part of FA-12.1. */
  host: z.string(),

  queuedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),

  exitCode: z.number().int().nullable(),
  failureReason: runFailureReasonSchema.nullable(),

  /**
   * The last Redis stream id written for this run. A client that reconnects
   * sends back the last id it saw; this is how far it could get.
   */
  lastStreamId: z.string().nullable(),

  /** Present once the collector has listed the output directory. */
  resultCount: z.number().int().min(0).nullable(),
});
export type Run = z.infer<typeof runSchema>;

/**
 * FA-08.3 / ADR-003. A read-only script aborts on request; a modifying one
 * requires an explicit confirmation *naming the script*, so that the abort is a
 * deliberate act rather than a mis-click in a list.
 */
export const abortRunRequestSchema = z.object({
  /**
   * Must equal the run's `scriptFileName` for a modifying or unknown script.
   * Ignored for read-only ones, where no confirmation is required.
   */
  confirmScriptName: z.string().trim().max(255).optional(),
});
export type AbortRunRequest = z.infer<typeof abortRunRequestSchema>;

/** Each escalation stage is a run event, so the audit shows how far it went. */
export const abortStageSchema = z.enum(["sigint", "sigterm", "sigkill"]);
export type AbortStage = z.infer<typeof abortStageSchema>;

/**
 * The run's own history, separate from the terminal bytes. The terminal is the
 * process's output; this is what the platform did.
 */
export const runEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  at: z.string().datetime({ offset: true }),
  kind: z.enum([
    "queued",
    "claimed",
    "connected",
    "pty_opened",
    "started",
    "abort_requested",
    "abort_signalled",
    "exited",
    "collected",
    "error",
  ]),
  /** Set on `abort_signalled`. */
  stage: abortStageSchema.nullable(),
  message: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const runListQuerySchema = z.object({
  areaId: z.string().uuid().optional(),
  scriptId: z.string().uuid().optional(),
  status: runStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

/**
 * FA-07.2 / ADR-006. A finished run's terminal history is persisted once, so the
 * capped Redis stream may expire without taking the scrollback with it. This is
 * what the console loads when a user opens a run that is already over: the same
 * bytes, from the durable copy instead of the live one.
 */
export const runTranscriptSchema = z.object({
  runId: z.string().uuid(),
  /** Base64, because the payload is PTY bytes and not text (ADR-006). */
  contentBase64: z.string(),
  sizeBytes: z.number().int().min(0),
  /** True when the run outran STREAM_MAXLEN and the head was trimmed. */
  truncated: z.boolean(),
});
export type RunTranscript = z.infer<typeof runTranscriptSchema>;
