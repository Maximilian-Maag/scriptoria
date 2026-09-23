import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseOptionalBody, parsePath } from "../src/lib/http";

/**
 * FA-08.3 / ADR-003, at the layer that got it wrong: a read-only script is
 * stopped by the request *itself*, so the abort request carries no body — and a
 * request that carries nothing must not be refused as malformed.
 *
 * The distinction is invisible to `request.json()`. A DELETE issued with no body
 * still reaches a route handler as a request that has a body *stream*, which is
 * empty; `json()` on it throws, and the abort came back as
 * `validation_failed` / "The request body is not valid JSON" (422) without ever
 * reaching the service. Hence a reader that can tell "nothing" from "nonsense".
 */

const abortRequest = z.object({ confirmScriptName: z.string().trim().max(255).optional() });

/**
 * The two ways a client with nothing to say shapes a request.
 *
 * `bodyless` is the one that broke: a request constructed with no body at all
 * still reaches a route handler carrying an empty body *stream*, which is exactly
 * what `json()` refuses — `duplex` is what lets the stream exist here the way it
 * does on the wire.
 */
const bodyless = () =>
  new Request("http://backend.test/api/runs/run-1", {
    method: "DELETE",
    body: new ReadableStream({ start: (controller) => controller.close() }),
    duplex: "half",
  } as RequestInit);

const emptyBody = () =>
  new Request("http://backend.test/api/runs/run-1", {
    method: "DELETE",
    body: "",
    headers: { "content-type": "application/json" },
  });

describe("parseOptionalBody", () => {
  it("reads a request with no body at all as an empty body, not as malformed JSON", async () => {
    const request = bodyless();

    // The premise: the body stream is there, and reading it as JSON fails.
    expect(request.body).not.toBeNull();
    await expect(request.clone().json()).rejects.toThrow();

    const result = await parseOptionalBody(request, abortRequest);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({});
  });

  it("does the same for an explicitly empty body", async () => {
    const result = await parseOptionalBody(emptyBody(), abortRequest);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({});
  });

  it("still refuses a body that is not JSON, and says so", async () => {
    const request = new Request("http://backend.test/api/runs/run-1", {
      method: "DELETE",
      body: "not json",
      headers: { "content-type": "application/json" },
    });

    const result = await parseOptionalBody(request, abortRequest);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("validation_failed");
    expect(!result.ok && result.message).toBe("The request body is not valid JSON");
  });

  it("still refuses a body the schema rejects, field paths intact", async () => {
    const request = new Request("http://backend.test/api/runs/run-1", {
      method: "DELETE",
      body: JSON.stringify({ confirmScriptName: 42 }),
      headers: { "content-type": "application/json" },
    });

    const result = await parseOptionalBody(request, abortRequest);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.details?.[0]?.path).toBe("confirmScriptName");
  });

  it("passes a valid body through", async () => {
    const request = new Request("http://backend.test/api/runs/run-1", {
      method: "DELETE",
      body: JSON.stringify({ confirmScriptName: "site-rollout.sh" }),
      headers: { "content-type": "application/json" },
    });

    const result = await parseOptionalBody(request, abortRequest);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ confirmScriptName: "site-rollout.sh" });
  });

  it("refuses an absent body when the schema needs one, rather than accepting it", async () => {
    // The optional reader must not become a way to skip validation.
    const required = z.object({ confirmScriptName: z.string() });

    const result = await parseOptionalBody(bodyless(), required);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("validation_failed");
    expect(!result.ok && result.details?.[0]?.path).toBe("confirmScriptName");
  });
});

/**
 * FA-02's "the control plane answers in one shape", for the input that had no
 * validation at all: the path segment.
 *
 * A non-UUID `{runId}` reached Postgres as a `uuid` comparison and came back
 * `22P02 invalid input syntax for type uuid` — a 500 with an empty body, from a
 * typo, on a route any signed-in account can reach.
 */
describe("parsePath", () => {
  it("rejects a segment that cannot be an id, and names it", () => {
    const path = parsePath({ runId: "not-a-uuid" });

    expect(path.ok).toBe(false);
    expect(!path.ok && path.code).toBe("validation_failed");
    expect(!path.ok && path.details?.[0]?.path).toBe("runId");
    expect(!path.ok && path.details?.[0]?.message).toBe("Must be a UUID");
  });

  it("names the offending segment when a path carries several ids", () => {
    const path = parsePath({
      areaId: "00000000-0000-4000-8000-000000000001",
      entitlementId: "nope",
    });

    expect(path.ok).toBe(false);
    expect(!path.ok && path.details?.[0]?.path).toBe("entitlementId");
  });

  it("passes a well-formed path through unchanged", () => {
    const areaId = "00000000-0000-4000-8000-000000000001";
    const sourceId = "00000000-0000-4000-8000-000000000002";

    const path = parsePath({ areaId, sourceId });

    expect(path.ok).toBe(true);
    expect(path.ok && path.value).toEqual({ areaId, sourceId });
  });
});

/**
 * And the same thing through the route handler: a malformed id is the caller's
 * mistake, answered in the envelope, and never reaches a service.
 */
const { abortRun, readSession } = vi.hoisted(() => ({
  abortRun: vi.fn(),
  readSession: vi.fn(),
}));

vi.mock("@/lib/services/runService", () => ({ abortRun, getRun: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ readSession }));

describe("DELETE /api/runs/{runId}", () => {
  /** An id the path guard accepts, so the test is about the body, not the path. */
  const RUN_ID = "00000000-0000-4000-8000-000000000009";

  const SESSION = {
    id: "session-1",
    username: "admin.branch",
    displayName: "Branch Admin",
    role: "administrator" as const,
    groups: [],
    areaIds: [],
    createdAt: Date.now(),
  };

  it("attempts the abort when the request carries no body", async () => {
    readSession.mockResolvedValue(SESSION);
    abortRun.mockResolvedValue({ ok: true, value: undefined });

    const { DELETE } = await import("../src/app/api/runs/[runId]/route");
    const response = await DELETE(
      new Request(`http://backend.test/api/runs/${RUN_ID}`, { method: "DELETE" }),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );

    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(abortRun.mock.calls[0]?.[1]).toBe(RUN_ID);
    expect(abortRun.mock.calls[0]?.[2]).toEqual({});
    expect(response.status).toBe(204);
  });

  it("answers a malformed id in the envelope instead of reaching the service", async () => {
    readSession.mockResolvedValue(SESSION);
    abortRun.mockClear();

    const { DELETE, GET } = await import("../src/app/api/runs/[runId]/route");
    const params = { params: Promise.resolve({ runId: "not-a-uuid" }) };

    const aborted = await DELETE(
      new Request("http://backend.test/api/runs/not-a-uuid", { method: "DELETE" }),
      params,
    );
    expect(aborted.status).toBe(422);
    expect(abortRun).not.toHaveBeenCalled();

    const read = await GET(new Request("http://backend.test/api/runs/not-a-uuid"), params);
    const body = (await read.json()) as { error?: { code?: string } };
    expect(read.status).toBe(422);
    expect(body.error?.code).toBe("validation_failed");
  });

  it("still refuses a body that is not JSON", async () => {
    readSession.mockResolvedValue(SESSION);
    abortRun.mockClear();

    const { DELETE } = await import("../src/app/api/runs/[runId]/route");
    const response = await DELETE(
      new Request(`http://backend.test/api/runs/${RUN_ID}`, {
        method: "DELETE",
        body: "{oops",
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );

    expect(response.status).toBe(422);
    expect(abortRun).not.toHaveBeenCalled();
  });
});
