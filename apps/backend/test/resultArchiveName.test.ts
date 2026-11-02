import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/lib/auth/session";

/**
 * FA-09.3 — the names a downloaded ZIP carries: its own, and the entry names
 * inside it.
 *
 * Both are built from names that came off the script VM. The archive's own name
 * is built from `run.scriptFileName`, which is whatever the catalog scan
 * recorded; an entry name is the relative path SFTP reported. `resultService`
 * had its own base-name rule that skipped the sanitiser
 * `packages/core/src/resultFiles.ts` already applies, so a non-Latin-1 script
 * name landed in an invalid `content-disposition` and threw — and the same
 * unsanitised names went into the ZIP.
 *
 * The repositories are mocked and the naming rule is not: `readFile` hands back
 * a real stream, so the archive is actually built and read.
 */

const { findRunById, listSourcesForAreas, listResults, record, readFile } = vi.hoisted(() => ({
  findRunById: vi.fn(),
  listSourcesForAreas: vi.fn(),
  listResults: vi.fn(),
  record: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@scriptoria/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scriptoria/db")>();
  return {
    ...actual,
    runRepository: { ...actual.runRepository, findRunById },
    areaRepository: { ...actual.areaRepository, listSourcesForAreas },
    resultRepository: { ...actual.resultRepository, listResults },
    auditRepository: { ...actual.auditRepository, record },
  };
});

vi.mock("../src/lib/runner/client", () => ({ readFile }));

const { archiveResults } = await import("../src/lib/services/resultService");

const RUN_ID = "00000000-0000-4000-8000-000000000009";
const QUEUED_AT = new Date("2026-03-04T09:15:30Z");

const SESSION: Session = {
  id: "session-1",
  username: "admin.branch",
  displayName: "Branch Admin",
  role: "administrator",
  groups: [],
  areaIds: ["area-1"],
  createdAt: QUEUED_AT.getTime(),
  lastSeenAt: QUEUED_AT.getTime(),
  expiresAt: new Date(QUEUED_AT.getTime() + 3_600_000),
};

const RUN = {
  id: RUN_ID,
  areaId: "area-1",
  host: "vm1.example.test",
  outputPath: "/opt/scriptoria/export",
  scriptFileName: "site-rollout.sh",
  queuedAt: QUEUED_AT,
};

const file = (path: string) => ({
  path,
  name: path.split("/").at(-1) ?? path,
  sizeBytes: 5,
  modifiedAt: QUEUED_AT.toISOString(),
  contentType: "text/plain",
  previewable: true,
});

/** The runner is not here; a stream is all the archive needs to be built. */
const readable = () =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("hello"));
      controller.close();
    },
  });

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

beforeEach(() => {
  findRunById.mockReset();
  listSourcesForAreas.mockReset();
  listResults.mockReset();
  record.mockReset();
  readFile.mockReset();

  findRunById.mockResolvedValue(RUN);
  listSourcesForAreas.mockResolvedValue([
    { host: "vm1.example.test", port: 22, username: "scriptoria" },
  ]);
  listResults.mockResolvedValue([file("rollout.log")]);
  // The runner is not here; a stream of bytes is all the archive needs, and a
  // real one lets the entry path run rather than aborting on a missing runner.
  readFile.mockImplementation(async () => ({ ok: true, value: { header: {}, body: readable() } }));
});

const archiveFor = async (scriptFileName: string, paths: string[]) => {
  findRunById.mockResolvedValue({ ...RUN, scriptFileName });
  listResults.mockResolvedValue(paths.map(file));

  const result = await archiveResults(SESSION, RUN_ID, { paths: [] }, { sourceIp: null });
  if (!result.ok) throw new Error(`archive refused: ${result.message}`);
  return result.value;
};

describe("the archive's own name", () => {
  it("date-stamps and sanitises through the core rule", async () => {
    const { name } = await archiveFor("site-rollout.sh", ["rollout.log"]);
    expect(name).toBe("site-rollout-2026-03-04-09-15-30.zip");
  });

  it("does not carry a control character or a non-Latin-1 name into the header", async () => {
    const { name } = await archiveFor("réport\nnightly.sh", ["rollout.log"]);
    expect(name).toBe("r-port-nightly-2026-03-04-09-15-30.zip");
  });

  it("still answers with a name when the script name leaves nothing to build on", async () => {
    const { name } = await archiveFor(".sh", ["rollout.log"]);
    expect(name).toBe("results-2026-03-04-09-15-30.zip");
  });
});

describe("the names inside the archive", () => {
  it("gives every entry the same sanitised name the download would", async () => {
    const { body } = await archiveFor("site-rollout.sh", [
      "line\nbreak.txt",
      "sites/日本語/report.csv",
    ]);
    const zip = await drain(body);

    expect(zip.includes(Buffer.from("line-break.txt"))).toBe(true);
    // The directory separators are kept: a ZIP entry is a path, not a name.
    expect(zip.includes(Buffer.from("sites/---/report.csv"))).toBe(true);
  });
});
