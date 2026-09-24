import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FA-09.2 / FA-09.3 — the response header built from a result file's name.
 *
 * A result file name is whatever SFTP reported from the script VM (FA-09.6),
 * and there a newline is a perfectly legal file name character. `filenameSchema`
 * forbids `/`, `.` and `..` and nothing else. Both a control character and a
 * character outside Latin-1 make `content-disposition` an invalid header value,
 * and `Headers` **throws** on one rather than rendering it — so a single such
 * name turns that file's download, and the run's whole ZIP, into a 500. The
 * header is built through the core sanitiser so that cannot happen.
 *
 * The services are mocked: what is under test is the header the route builds
 * from the name the service hands it, not how the name was found.
 */

const { readSession, downloadResult, archiveResults } = vi.hoisted(() => ({
  readSession: vi.fn(),
  downloadResult: vi.fn(),
  archiveResults: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ readSession }));
vi.mock("@/lib/services/resultService", () => ({ downloadResult, archiveResults }));

const RUN_ID = "00000000-0000-4000-8000-000000000009";

const SESSION = {
  id: "session-1",
  username: "admin.branch",
  displayName: "Branch Admin",
  role: "administrator" as const,
  groups: [],
  areaIds: ["area-1"],
  createdAt: Date.now(),
  expiresAt: new Date(Date.now() + 3_600_000),
};

const emptyBody = () =>
  new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

beforeEach(() => {
  readSession.mockResolvedValue(SESSION);
  downloadResult.mockReset();
  archiveResults.mockReset();
});

describe("GET /api/runs/{runId}/results/file", () => {
  const get = async (name: string) => {
    const { GET } = await import("../src/app/api/runs/[runId]/results/file/route");
    downloadResult.mockResolvedValue({
      ok: true,
      value: {
        header: { truncated: false, sizeBytes: 5 },
        body: emptyBody(),
        name,
        contentType: "text/plain",
      },
    });
    return GET(
      new Request(
        `http://backend.test/api/runs/${RUN_ID}/results/file?path=${encodeURIComponent(name)}`,
      ),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
  };

  it("does not throw on a name carrying a control character", async () => {
    const response = await get("line\nbreak.txt");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="line-break.txt"',
    );
  });

  it("does not throw on a name that is not Latin-1-representable", async () => {
    const response = await get("日本語.txt");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="---.txt"');
  });

  it("leaves a name that was already safe exactly as it was", async () => {
    const response = await get("site-rollout.csv");

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="site-rollout.csv"',
    );
  });
});

describe("POST /api/runs/{runId}/results/archive", () => {
  const post = async (name: string) => {
    const { POST } = await import("../src/app/api/runs/[runId]/results/archive/route");
    archiveResults.mockResolvedValue({
      ok: true,
      value: { body: emptyBody(), name, fileCount: 3 },
    });
    return POST(
      new Request(`http://backend.test/api/runs/${RUN_ID}/results/archive`, {
        method: "POST",
        body: JSON.stringify({ paths: [] }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ runId: RUN_ID }) },
    );
  };

  it("does not throw on an archive name derived from a non-Latin-1 script", async () => {
    const response = await post("réport\nnightly-2026-03-04-09-15-30.zip");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="r-port-nightly-2026-03-04-09-15-30.zip"',
    );
  });

  it("leaves an archive name that was already safe exactly as it was", async () => {
    const response = await post("site-rollout-2026-03-04-09-15-30.zip");

    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="site-rollout-2026-03-04-09-15-30.zip"',
    );
  });
});
