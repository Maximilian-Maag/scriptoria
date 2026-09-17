import type {
  AbortRunRequest,
  ApiError,
  AreaSummary,
  LoginRequest,
  ResultList,
  Run,
  RunEvent,
  RunTranscript,
  Script,
  SessionResponse,
  StartRunRequest,
} from "@scriptoria/contracts";

/**
 * The typed client, built on the same schemas the control plane validates with
 * (`@scriptoria/contracts`). One package, one definition, three applications —
 * which is the entire argument ADR-002 makes for the monorepo.
 *
 * Every call goes through `/api/proxy`, which is the browser's only route to
 * the control plane. Nothing here knows the backend's address.
 */

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError["error"]["code"],
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/proxy${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    // Every non-2xx from the control plane is the same envelope, so there is
    // one place that turns a failure into something a person can read.
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new ApiFailure(
      response.status,
      body?.error.code ?? "internal",
      body?.error.message ?? "Something went wrong",
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  session: () => call<SessionResponse>("/auth/session"),

  login: (credentials: LoginRequest) =>
    call<{ user: NonNullable<SessionResponse["user"]> }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    }),

  logout: () => call<void>("/auth/logout", { method: "POST" }),

  areas: () => call<AreaSummary[]>("/areas"),

  scripts: (areaId: string) => call<Script[]>(`/areas/${areaId}/scripts`),

  rescan: (areaId: string) => call<Script[]>(`/areas/${areaId}/scripts`, { method: "POST" }),

  startRun: (request: StartRunRequest) =>
    call<Run>("/runs", { method: "POST", body: JSON.stringify(request) }),

  run: (runId: string) => call<Run>(`/runs/${runId}`),

  runEvents: (runId: string) => call<RunEvent[]>(`/runs/${runId}/events`),

  transcript: (runId: string) => call<RunTranscript>(`/runs/${runId}/transcript`),

  abortRun: (runId: string, request: AbortRunRequest) =>
    call<void>(`/runs/${runId}`, { method: "DELETE", body: JSON.stringify(request) }),

  results: (runId: string) => call<ResultList>(`/runs/${runId}/results`),

  /**
   * Not fetched — handed to the browser as a URL, so that a download is a
   * download rather than a blob assembled in a tab (FA-09.2, FA-09.6).
   */
  resultFileUrl: (runId: string, path: string) =>
    `/api/proxy/runs/${runId}/results/file?path=${encodeURIComponent(path)}`,
};
