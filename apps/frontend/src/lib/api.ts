import type {
  AbortRunRequest,
  ApiError,
  Area,
  AreaSummary,
  CreateAreaRequest,
  CreateGroupEntitlementRequest,
  CreateScriptSourceRequest,
  LoginRequest,
  ResultList,
  Run,
  RunEvent,
  RunListQuery,
  RunTranscript,
  Script,
  SessionResponse,
  StartRunRequest,
  UpdateAreaRequest,
} from "@scriptoria/contracts";

/**
 * The typed client, built on the same schemas the control plane validates with
 * (`@scriptoria/contracts`). One package, one definition, three applications —
 * which is the entire argument ADR-002 makes for the monorepo.
 *
 * Every call goes through `/api/proxy`, which is the browser's only route to
 * the control plane. Nothing here knows the backend's address.
 */

/** What `GET /runs` answers with: one page of runs, and how big the whole is. */
export interface RunList {
  items: Run[];
  total: number;
  limit: number;
  offset: number;
}

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

  /**
   * FA-05.4, FA-09.5 — the run history, so a finished run can be found again
   * and its result checked. Bounded to the session's areas by the control
   * plane; nothing here widens it.
   */
  runs: (query: Partial<RunListQuery> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    return call<RunList>(`/runs${search ? `?${search}` : ""}`);
  },

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

  /**
   * FA-11. Grouped under `admin` because these are the root account's calls and
   * nothing else's — the same split the control plane makes with `requireRoot`,
   * visible on this side too rather than only on the wire.
   *
   * Every mutation answers with the whole area, so a component never has to
   * reconstruct what the server now holds from what it just sent.
   */
  admin: {
    areas: () => call<Area[]>("/admin/areas"),

    createArea: (request: CreateAreaRequest) =>
      call<Area>("/admin/areas", { method: "POST", body: JSON.stringify(request) }),

    updateArea: (areaId: string, request: UpdateAreaRequest) =>
      call<Area>(`/admin/areas/${areaId}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),

    deleteArea: (areaId: string) => call<void>(`/admin/areas/${areaId}`, { method: "DELETE" }),

    addSource: (areaId: string, request: CreateScriptSourceRequest) =>
      call<Area>(`/admin/areas/${areaId}/sources`, {
        method: "POST",
        body: JSON.stringify(request),
      }),

    removeSource: (areaId: string, sourceId: string) =>
      call<Area>(`/admin/areas/${areaId}/sources/${sourceId}`, { method: "DELETE" }),

    grantEntitlement: (areaId: string, request: CreateGroupEntitlementRequest) =>
      call<Area>(`/admin/areas/${areaId}/entitlements`, {
        method: "POST",
        body: JSON.stringify(request),
      }),

    revokeEntitlement: (areaId: string, entitlementId: string) =>
      call<Area>(`/admin/areas/${areaId}/entitlements/${entitlementId}`, { method: "DELETE" }),
  },
};
