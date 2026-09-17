import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { z } from "zod";
import {
  abortRunRequestSchema,
  apiErrorSchema,
  areaSchema,
  areaSummarySchema,
  auditEntrySchema,
  auditQuerySchema,
  createAreaRequestSchema,
  createGroupEntitlementRequestSchema,
  createScriptSourceRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
  paginated,
  resultArchiveRequestSchema,
  resultListSchema,
  resultPreviewQuerySchema,
  resultPreviewSchema,
  runEventSchema,
  runListQuerySchema,
  runSchema,
  runTranscriptSchema,
  scheduleSchema,
  scriptSchema,
  sessionResponseSchema,
  startRunRequestSchema,
  updateAreaRequestSchema,
  updateScheduleRequestSchema,
} from "@scriptoria/contracts";

/**
 * The REST contract, generated from the schemas the routes actually validate
 * with — never written alongside them.
 *
 * This is the promise ADR-002 makes for the monorepo. A hand-written API
 * document is a second definition of the same thing, and a second definition
 * drifts: it is wrong the first time a field is added and nobody notices until
 * an integrator builds against it. Here a field that does not exist in
 * `@scriptoria/contracts` cannot appear in the published document, because
 * there is nowhere for it to come from.
 *
 * What is *not* generated is the part no schema knows: which routes require a
 * session, which require root, and what each one is for. That lives here,
 * beside the path, and is the only thing in this file worth reviewing by hand.
 *
 * The terminal WebSocket is deliberately absent. OpenAPI describes requests and
 * responses, and a bidirectional byte stream held open for the life of a run is
 * neither (ADR-007); its frames are specified in `@scriptoria/contracts`
 * (`stream.ts`) and described in the architecture model instead.
 */

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ── Security ─────────────────────────────────────────────────────────────────

/**
 * One scheme, and it is a cookie rather than a bearer token — which is a design
 * decision and not an implementation detail. NFR-03 requires that entitlement
 * can be revoked while a session is live; a self-contained token cannot do that
 * (see `lib/auth/session.ts`). The cookie is httpOnly, so no client-side script
 * ever holds it.
 */
const SESSION = registry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "scriptoria_session",
  description:
    "An opaque server-side session id, set by POST /auth/login and cleared by POST /auth/logout. Sent automatically by the browser; nothing reads it in JavaScript.",
});

const secured = [{ [SESSION.name]: [] }];

// ── Components ───────────────────────────────────────────────────────────────

const ref = <T extends z.ZodTypeAny>(name: string, schema: T) => registry.register(name, schema);

const ApiError = ref("ApiError", apiErrorSchema);
const Area = ref("Area", areaSchema);
const AreaSummary = ref("AreaSummary", areaSummarySchema);
const AuditEntry = ref("AuditEntry", auditEntrySchema);
const Script = ref("Script", scriptSchema);
const Run = ref("Run", runSchema);
const RunEvent = ref("RunEvent", runEventSchema);
const RunTranscript = ref("RunTranscript", runTranscriptSchema);
const ResultList = ref("ResultList", resultListSchema);
const ResultPreview = ref("ResultPreview", resultPreviewSchema);
const Schedule = ref("Schedule", scheduleSchema);
const SessionResponse = ref("SessionResponse", sessionResponseSchema);
const RunPage = ref("RunPage", paginated(Run));
const AuditPage = ref("AuditPage", paginated(AuditEntry));

// ── Response helpers ─────────────────────────────────────────────────────────

const json = (description: string, schema: z.ZodTypeAny) => ({
  description,
  content: { "application/json": { schema } },
});

const problem = (description: string) => json(description, ApiError);

/**
 * The failures every authenticated route can produce, spelled out rather than
 * left implied. A 403 and a 404 are not interchangeable here: a run in an area
 * the caller is not entitled to answers 404, because confirming that it exists
 * would itself be a disclosure (NFR-18).
 */
const AUTHENTICATED = {
  401: problem("No session, or the session has expired"),
  500: problem("Unexpected failure. The message is safe to show; the cause is logged, not sent"),
};

const ROOT_ONLY = {
  ...AUTHENTICATED,
  403: problem("Signed in, but not the root account"),
};

const VALIDATION = {
  422: problem("The request did not match the schema. `details` names the fields"),
};

const NOT_FOUND = (what: string) => ({
  404: problem(`No such ${what}, or one the caller is not entitled to see`),
});

const body = (schema: z.ZodTypeAny, description: string) => ({
  body: { description, required: true, content: { "application/json": { schema } } },
});

/**
 * `offset` comes out of the generator typed `["integer", "null"]`. Nothing in
 * the schema says that: it is `z.coerce.number().int().min(0).default(0)`, and
 * the generator mistypes exactly the combination of a coerced number and a
 * minimum of zero — `limit`, whose minimum is 1, is unaffected, and so is every
 * uncoerced `.min(0)` in the document. A published contract saying the field
 * may be null would make every generated client unwrap something that is never
 * absent, so it is corrected here rather than passed on.
 */
const paged = <T extends z.AnyZodObject>(schema: T): T =>
  schema.extend({
    // Metadata replaces the generated schema rather than merging into it, so
    // the constraints have to be restated. Both offsets are `min(0).default(0)`.
    offset: (schema.shape["offset"] as z.ZodTypeAny).openapi({
      type: "integer",
      minimum: 0,
      default: 0,
    }),
  }) as unknown as T;

const areaId = {
  name: "areaId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const, format: "uuid" },
};
const runId = {
  name: "runId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const, format: "uuid" },
};

// ── Authentication (FA-01) ───────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/auth/login",
  operationId: "login",
  tags: ["Authentication"],
  summary: "Sign in against the directory",
  description:
    "Binds to the directory as the caller (NFR-02), reads back the groups it holds and resolves them against the area mapping. The entitlement is built here and nowhere else — it is discarded in full at every login and never carried over (FA-02.2).\n\nAny directory account may authenticate successfully. One in no entitled group gets a session with an empty area set, which is a valid outcome and not an error (FA-01.4).",
  security: [],
  request: body(loginRequestSchema, "Directory credentials"),
  responses: {
    200: json("Signed in. The session cookie is set on this response", loginResponseSchema),
    401: problem("The directory rejected the credentials"),
    ...VALIDATION,
    502: problem("The directory could not be reached"),
  },
});

registry.registerPath({
  method: "post",
  path: "/auth/logout",
  operationId: "logout",
  tags: ["Authentication"],
  summary: "Sign out",
  description: "Deletes the server-side session and clears the cookie. Idempotent.",
  security: secured,
  responses: { 204: { description: "Signed out, whether or not there was a session" } },
});

registry.registerPath({
  method: "get",
  path: "/auth/session",
  operationId: "getSession",
  tags: ["Authentication"],
  summary: "Who is signed in",
  description:
    "The account, its role and the areas its groups reach right now. Re-read rather than remembered, because an entitlement can be revoked mid-session (NFR-03).",
  security: secured,
  responses: {
    200: json("The session, or `user: null` when there is none", SessionResponse),
  },
});

// ── Catalog (FA-03) ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/areas",
  operationId: "listAreas",
  tags: ["Catalog"],
  summary: "The areas this session reaches",
  description:
    "Bounded by the session's area set and by nothing else (FA-02.4). An empty list is a valid answer (FA-01.4).",
  security: secured,
  responses: { 200: json("The entitled areas", z.array(AreaSummary)), ...AUTHENTICATED },
});

registry.registerPath({
  method: "get",
  path: "/areas/{areaId}/scripts",
  operationId: "listScripts",
  tags: ["Catalog"],
  summary: "The scripts of one area",
  description:
    "Each script with its parsed header and its criticality (FA-03.4, FA-03.5). The body is never included — real scripts run to thousands of lines and nobody reads one in a catalog.",
  security: secured,
  responses: {
    200: json("The area's scripts", z.array(Script)),
    ...AUTHENTICATED,
    ...NOT_FOUND("area"),
  },
  parameters: [areaId],
});

registry.registerPath({
  method: "post",
  path: "/areas/{areaId}/scripts",
  operationId: "rescanScripts",
  tags: ["Catalog"],
  summary: "Rescan the area's script directories",
  description:
    "Re-reads the mapped directories on the script VM and re-parses each header (ADR-004). The catalog is a cache of what is on disk; this is how it is refreshed without waiting for it to expire.",
  security: secured,
  responses: {
    200: json("The catalog as it now stands", z.array(Script)),
    ...AUTHENTICATED,
    ...NOT_FOUND("area"),
    502: problem("The script VM could not be reached"),
  },
  parameters: [areaId],
});

// ── Runs (FA-05 … FA-08) ─────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/runs",
  operationId: "startRun",
  tags: ["Runs"],
  summary: "Start a script",
  description:
    "Queues the run and answers immediately. There are no parameters: either the set is fixed in the script, or it is asked for through the terminal after the start (FA-05.5).\n\n202, not 201 — the run is accepted, not running. Saying so is what lets the console show `queued` honestly.",
  security: secured,
  request: body(startRunRequestSchema, "The script to start"),
  responses: {
    202: json("Queued. Follow it on the terminal WebSocket or by polling", Run),
    ...AUTHENTICATED,
    ...NOT_FOUND("script"),
    409: problem("The area is already running as much as it permits"),
    ...VALIDATION,
  },
});

registry.registerPath({
  method: "get",
  path: "/runs",
  operationId: "listRuns",
  tags: ["Runs"],
  summary: "Run history",
  description:
    "Newest first, bounded by the session's areas. A run whose worker died is reaped on the way out, so a dead run stops showing as `running` in the one view somebody opens to find out what happened to it.",
  security: secured,
  request: { query: paged(runListQuerySchema) },
  responses: { 200: json("One page of runs", RunPage), ...AUTHENTICATED, ...VALIDATION },
});

registry.registerPath({
  method: "get",
  path: "/runs/{runId}",
  operationId: "getRun",
  tags: ["Runs"],
  summary: "One run",
  security: secured,
  responses: { 200: json("The run", Run), ...AUTHENTICATED, ...NOT_FOUND("run") },
  parameters: [runId],
});

registry.registerPath({
  method: "delete",
  path: "/runs/{runId}",
  operationId: "abortRun",
  tags: ["Runs"],
  summary: "Stop a running script",
  description:
    "Staged: SIGINT, then SIGTERM, then SIGKILL to the process group, each stage recorded (ADR-003). A modifying or undeclared script requires `confirmScriptName` to equal the run's own file name, so that stopping one is a deliberate act rather than a mis-click in a list (FA-08.3). A read-only script needs no body at all.",
  security: secured,
  request: {
    body: {
      description: "Confirmation, for a modifying or undeclared script",
      required: false,
      content: { "application/json": { schema: abortRunRequestSchema } },
    },
  },
  responses: {
    204: { description: "The abort was requested. The run reaches `aborted` when it ends" },
    ...AUTHENTICATED,
    ...NOT_FOUND("run"),
    409: problem("The run is already over, or the confirmation does not match the script"),
    ...VALIDATION,
  },
  parameters: [runId],
});

registry.registerPath({
  method: "get",
  path: "/runs/{runId}/events",
  operationId: "listRunEvents",
  tags: ["Runs"],
  summary: "What the platform did during the run",
  description:
    "Queued, claimed, connected, started, each abort stage, exited, collected. Separate from the terminal, which is what the *process* said.",
  security: secured,
  responses: {
    200: json("The run's events", z.array(RunEvent)),
    ...AUTHENTICATED,
    ...NOT_FOUND("run"),
  },
  parameters: [runId],
});

registry.registerPath({
  method: "get",
  path: "/runs/{runId}/transcript",
  operationId: "getRunTranscript",
  tags: ["Runs"],
  summary: "The terminal scrollback of a finished run",
  description:
    "The durable copy of the PTY bytes, base64 because they are bytes and not text (ADR-006). The live stream is capped and expires; this does not, so a run opened a month later shows what it showed while it ran (FA-07.2). A run that printed nothing answers with an empty transcript rather than a 404 — many scripts deliberately print nothing (FA-07.5).",
  security: secured,
  responses: {
    200: json("The scrollback, `truncated` when the run outran the stream cap", RunTranscript),
    ...AUTHENTICATED,
    ...NOT_FOUND("run"),
  },
  parameters: [runId],
});

// ── Results (FA-09) ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/runs/{runId}/results",
  operationId: "listResults",
  tags: ["Results"],
  summary: "The files a run produced",
  description:
    "Listed for a failed run exactly as for a successful one: a run that failed halfway still wrote whatever it wrote, and that is usually the thing somebody came to look at (FA-09.5).",
  security: secured,
  responses: { 200: json("The result set", ResultList), ...AUTHENTICATED, ...NOT_FOUND("run") },
  parameters: [runId],
});

registry.registerPath({
  method: "get",
  path: "/runs/{runId}/results/file",
  operationId: "downloadResult",
  tags: ["Results"],
  summary: "Download one result file",
  description:
    "Streamed end to end — script VM, runner, Redis, here, browser — with nothing on the path holding the whole file. Always `Content-Disposition: attachment`: a result is the script owner's content, and this platform does not render other people's HTML in its own origin. Audited (FA-12.2).",
  security: secured,
  request: { query: z.object({ path: z.string().min(1).max(4096) }) },
  responses: {
    200: {
      description: "The file",
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    },
    ...AUTHENTICATED,
    ...NOT_FOUND("run or file"),
    ...VALIDATION,
    502: problem("The script VM could not be reached"),
  },
  parameters: [runId],
});

registry.registerPath({
  method: "get",
  path: "/runs/{runId}/results/preview",
  operationId: "previewResult",
  tags: ["Results"],
  summary: "Read a result on screen",
  description:
    "FA-09.1 and FA-09.4 — content to read and to copy, not to save. Truncated to a size a browser can hold, and marked as truncated when it was.",
  security: secured,
  request: { query: resultPreviewQuerySchema },
  responses: {
    200: json("The content, decoded where it is text", ResultPreview),
    ...AUTHENTICATED,
    ...NOT_FOUND("run or file"),
    ...VALIDATION,
  },
  parameters: [runId],
});

registry.registerPath({
  method: "post",
  path: "/runs/{runId}/results/archive",
  operationId: "downloadResultArchive",
  tags: ["Results"],
  summary: "Download the result set as one ZIP",
  description:
    "The normal case rather than a convenience: one run routinely writes hundreds of files across dozens of sites (FA-09.3). An empty `paths` means all of them.\n\nThe entries are fetched one at a time — each is a request to the runner, and an 800-file archive must not put 800 of them on its queue at once. There is no `Content-Length`: the compressed size is not known until the last entry is written, and a wrong one is worse than none.",
  security: secured,
  request: body(resultArchiveRequestSchema, "Which files, or none for all of them"),
  responses: {
    200: {
      description: "The archive, streamed as it is built",
      content: { "application/zip": { schema: { type: "string", format: "binary" } } },
      headers: {
        "x-scriptoria-file-count": {
          description: "How many entries the archive holds",
          schema: { type: "integer" },
        },
      },
    },
    ...AUTHENTICATED,
    ...NOT_FOUND("run"),
    ...VALIDATION,
  },
  parameters: [runId],
});

// ── Schedules (FA-10) ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/schedules",
  operationId: "listSchedules",
  tags: ["Schedules"],
  summary: "What runs regularly",
  description:
    "Read live off each script VM's crontab on every request (ADR-005). There is no cached copy to go stale, which is the point: a schedule changed over SSH shows up here without anyone telling the platform. `nextRunAt` is derived from the expression at read time.\n\nAvailable to administrators, not only to root — seeing what runs in an area is part of the area (FA-03.3).",
  security: secured,
  request: { query: z.object({ areaId: z.string().uuid().optional() }) },
  responses: { 200: json("The schedules", z.array(Schedule)), ...AUTHENTICATED, ...VALIDATION },
});

registry.registerPath({
  method: "patch",
  path: "/schedules/{scheduleId}",
  operationId: "updateSchedule",
  tags: ["Schedules"],
  summary: "Change a schedule",
  description:
    "Root only, and only ever the expression and the enabled flag. The platform rewrites only the block between its own delimiters; a line written by hand is shown and deliberately left alone (FA-10.4).",
  security: secured,
  request: body(updateScheduleRequestSchema, "The new expression, or the enabled flag"),
  responses: {
    200: json("The schedule as the crontab now holds it", Schedule),
    ...ROOT_ONLY,
    ...NOT_FOUND("schedule"),
    409: problem("The crontab was written by somebody else since it was read"),
    ...VALIDATION,
    502: problem("The script VM could not be reached"),
  },
  parameters: [{ name: "scheduleId", in: "path", required: true, schema: { type: "string" } }],
});

// ── Administration (FA-11) ───────────────────────────────────────────────────

/**
 * Everything below is `requireRoot`. Root is not a bigger administrator: these
 * routes decide what administrators can reach, and they do not let root reach
 * further itself. Every mutation is audited (FA-12.2) and re-entitles the live
 * sessions before it answers (NFR-03) — an administrator loses an area
 * mid-session, without being signed out.
 */

registry.registerPath({
  method: "get",
  path: "/admin/areas",
  operationId: "listAllAreas",
  tags: ["Administration"],
  summary: "Every area that exists",
  description:
    "Unfiltered by design. An area nobody is entitled to yet is exactly the area that needs administering, so this is not bounded by root's own entitlement.",
  security: secured,
  responses: {
    200: json("Every area, with its mappings and entitlements", z.array(Area)),
    ...ROOT_ONLY,
  },
});

registry.registerPath({
  method: "post",
  path: "/admin/areas",
  operationId: "createArea",
  tags: ["Administration"],
  summary: "Create an area",
  security: secured,
  request: body(createAreaRequestSchema, "The area"),
  responses: {
    201: json("The new area", Area),
    ...ROOT_ONLY,
    409: problem("An area of that name already exists"),
    ...VALIDATION,
  },
});

registry.registerPath({
  method: "get",
  path: "/admin/areas/{areaId}",
  operationId: "getAreaDetail",
  tags: ["Administration"],
  summary: "One area, with its mappings and entitlements",
  security: secured,
  responses: { 200: json("The area", Area), ...ROOT_ONLY, ...NOT_FOUND("area") },
  parameters: [areaId],
});

registry.registerPath({
  method: "patch",
  path: "/admin/areas/{areaId}",
  operationId: "updateArea",
  tags: ["Administration"],
  summary: "Rename or re-describe an area",
  security: secured,
  request: body(updateAreaRequestSchema, "The fields to change"),
  responses: {
    200: json("The area as it now stands", Area),
    ...ROOT_ONLY,
    ...NOT_FOUND("area"),
    409: problem("Another area already has that name"),
    ...VALIDATION,
  },
  parameters: [areaId],
});

registry.registerPath({
  method: "delete",
  path: "/admin/areas/{areaId}",
  operationId: "deleteArea",
  tags: ["Administration"],
  summary: "Delete an area",
  description:
    "An area anything has ever been run in cannot be deleted — a 409, not a cascade. Run history outranks tidying up the configuration (FA-12.1).",
  security: secured,
  responses: {
    204: { description: "Deleted" },
    ...ROOT_ONLY,
    ...NOT_FOUND("area"),
    409: problem("Something has been run in this area, so its history would have to go with it"),
  },
  parameters: [areaId],
});

registry.registerPath({
  method: "post",
  path: "/admin/areas/{areaId}/sources",
  operationId: "addScriptSource",
  tags: ["Administration"],
  summary: "Map a script directory onto the area",
  description:
    "Host and path, not path alone: NFR-07 allows a second script VM where two sets of scripts need runtimes that cannot coexist, and a global host setting would have to be unpicked to allow it.",
  security: secured,
  request: body(createScriptSourceRequestSchema, "The directory on the script VM"),
  responses: {
    200: json("The area, with the mapping added", Area),
    ...ROOT_ONLY,
    ...NOT_FOUND("area"),
    409: problem("That directory is already mapped onto this area"),
    ...VALIDATION,
  },
  parameters: [areaId],
});

registry.registerPath({
  method: "delete",
  path: "/admin/areas/{areaId}/sources/{sourceId}",
  operationId: "removeScriptSource",
  tags: ["Administration"],
  summary: "Unmap a script directory",
  security: secured,
  responses: {
    200: json("The area, with the mapping removed", Area),
    ...ROOT_ONLY,
    ...NOT_FOUND("area or mapping"),
  },
  parameters: [
    areaId,
    { name: "sourceId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
  ],
});

registry.registerPath({
  method: "post",
  path: "/admin/areas/{areaId}/entitlements",
  operationId: "grantEntitlement",
  tags: ["Administration"],
  summary: "Entitle a directory group to the area",
  description:
    "The group is *referenced*, never synchronised (FA-02.3, NFR-04). A name that matches nothing in the directory yet is a valid thing to save — it is matched at each login, not here.",
  security: secured,
  request: body(createGroupEntitlementRequestSchema, "The directory group's name"),
  responses: {
    200: json("The area, with the entitlement added", Area),
    ...ROOT_ONLY,
    ...NOT_FOUND("area"),
    409: problem("That group is already entitled to this area"),
    ...VALIDATION,
  },
  parameters: [areaId],
});

registry.registerPath({
  method: "delete",
  path: "/admin/areas/{areaId}/entitlements/{entitlementId}",
  operationId: "revokeEntitlement",
  tags: ["Administration"],
  summary: "Revoke a group's entitlement",
  description:
    "Takes effect on live sessions rather than at the next login (NFR-03). That is the whole reason sessions are held server-side instead of in a token.",
  security: secured,
  responses: {
    200: json("The area, with the entitlement removed", Area),
    ...ROOT_ONLY,
    ...NOT_FOUND("area or entitlement"),
  },
  parameters: [
    areaId,
    {
      name: "entitlementId",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
  ],
});

// ── Audit (FA-12) ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/admin/audit",
  operationId: "queryAuditLog",
  tags: ["Audit"],
  summary: "What the platform recorded",
  description:
    "Every sign-in, run, download and administrative change, newest first, filtered by account, action, area, run and time window.\n\nRoot only, like the rest of `/admin`: an administrator sees the areas, scripts, runs and results their groups reach (FA-02.4), and a log narrowed to the reader's own entitlements is not an audit log. Reading it is deliberately not itself audited — a read changes nothing, and recording every search would bury the acts the log exists for.",
  security: secured,
  request: { query: paged(auditQuerySchema) },
  responses: { 200: json("One page of the log", AuditPage), ...ROOT_ONLY, ...VALIDATION },
});

// ── Operations ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/health",
  operationId: "health",
  tags: ["Operations"],
  summary: "Liveness and dependency checks",
  description:
    "What the monitoring system polls (NFR-16). The platform raises no alerts of its own, so this endpoint's job is to be accurate rather than reassuring: it reports what it actually checked, and a degraded dependency is a 503.",
  security: [],
  responses: {
    200: json(
      "Everything answered",
      z.object({
        status: z.literal("ok"),
        checks: z.record(z.enum(["ok", "failed"])),
      }),
    ),
    503: json(
      "At least one dependency did not answer",
      z.object({
        status: z.literal("degraded"),
        checks: z.record(z.enum(["ok", "failed"])),
      }),
    ),
  },
});

// ── The document ─────────────────────────────────────────────────────────────

/**
 * Built once per process. Generation walks every registered schema, which is
 * cheap but not free, and the document cannot change without a redeploy.
 */
let cached: OpenAPIObject | null = null;

export function openApiDocument(): OpenAPIObject {
  cached ??= new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Scriptoria Control Plane",
      version: "0.1.0",
      description:
        "Select, start, drive and collect the results of existing Linux scripts on a script VM — without shell knowledge and without jump-server handwork.\n\nEvery path below is served under `/api`. Every non-2xx answer is the same error envelope, so a client has one failure shape to render rather than N.\n\nAuthorisation is by directory group and never by account (FA-02.1). A caller sees the areas their groups reach and nothing else; the `/admin` paths answer the root account alone.\n\nThe terminal WebSocket is not described here — OpenAPI describes requests and responses, and a bidirectional byte stream held open for the life of a run is neither (ADR-007).",
    },
    servers: [{ url: "/api", description: "The control plane, behind the reverse proxy" }],
    tags: [
      { name: "Authentication", description: "Directory login and the server-side session" },
      { name: "Catalog", description: "The areas a session reaches, and the scripts in one" },
      { name: "Runs", description: "Starting, following and stopping a script" },
      { name: "Results", description: "What a run wrote, one file or the set" },
      { name: "Schedules", description: "Recurring scripts, from the script VM's own crontab" },
      { name: "Administration", description: "Areas, mappings and entitlements. Root only" },
      { name: "Audit", description: "The recorded history of the platform. Root only" },
      { name: "Operations", description: "Health, for the monitoring system" },
    ],
  });
  return cached;
}
