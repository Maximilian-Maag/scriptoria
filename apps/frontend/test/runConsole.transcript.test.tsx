// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Run } from "@scriptoria/contracts";
import RunPage from "../src/app/(app)/runs/[runId]/page";

/**
 * FA-07.2 — a run that is over is read from the durable copy of its terminal.
 *
 * The console decides *once*, when it opens, whether the terminal's bytes come
 * from the socket or from the transcript on disk. It decides from the run
 * record it has at that moment — and if that record is the one react-query is
 * still holding from the page that watched this run start, the record says
 * `running` for as long as the refresh takes to come back. The console concludes
 * it is watching a live run, and never reads the transcript back underneath it.
 *
 * That is only visible on the round trip: watch a run start, leave the console,
 * come back once it has finished. The socket for it is gone and the durable copy
 * was never asked for, so an operator looking at a run with a whole transcript
 * on disk sees an empty terminal.
 *
 * Real React and real react-query on jsdom; the wire is faked at `fetch`, which
 * is where the browser would meet it.
 */

vi.mock("../src/components/TerminalView", async (importOriginal) => {
  // xterm wants a terminal with a size to measure. What is under test is which
  // source the page hands it, so the view is dropped and `isLive` — the rule the
  // page reads its decision through — is kept real rather than restated here.
  const actual = await importOriginal<typeof import("../src/components/TerminalView")>();
  return { ...actual, TerminalView: () => null };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const RUN_ID = "6f9a1c3e-1f2b-4a4c-9b1d-0d5c8e2f7a11";
const AREA_ID = "b1e1f3a7-7a2d-4b74-8b6d-3b3e8b8f5f3f";
const SCRIPT_ID = "3c2f5b7a-8d91-4e6f-a1b2-c3d4e5f60718";

const run = (status: Run["status"]): Run => ({
  id: RUN_ID,
  areaId: AREA_ID,
  scriptId: SCRIPT_ID,
  scriptFileName: "inventory.ps1",
  scriptTitle: "Inventory",
  criticality: "read-only",
  status,
  trigger: "manual",
  startedBy: "jdoe",
  host: "script-vm",
  queuedAt: "2026-09-24T09:00:00.000Z",
  startedAt: "2026-09-24T09:00:01.000Z",
  finishedAt: status === "succeeded" ? "2026-09-24T09:00:09.000Z" : null,
  exitCode: status === "succeeded" ? 0 : null,
  failureReason: null,
  lastStreamId: "1-1",
  resultCount: 4,
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** The run the control plane answers with, and every path the page asked for. */
function answering(answer: Run): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/api\/proxy/, "");
      asked.push(path);
      if (path === `/runs/${RUN_ID}`) return json(answer);
      if (path === `/runs/${RUN_ID}/transcript`)
        return json({ contentBase64: "UmVhZGluZyBpbnRlcmZhY2Vz", truncated: false });
      return new Response("", { status: 404 });
    }),
  );
  return asked;
}

async function open(seeded?: Run): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seeded) client.setQueryData(["run", RUN_ID], seeded);
  // `use(params)` suspends on the promise the router hands the page, so the
  // render has to be awaited: without the act scope React never comes back from
  // the fallback and nothing is ever asked for.
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <RunPage params={Promise.resolve({ runId: RUN_ID })} />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  return client;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("where the run console's terminal gets its content (FA-07.2)", () => {
  it("reads back a run you left and came back to, even though the record it holds still says the run is live", async () => {
    const asked = answering(run("succeeded"));

    // What the console left in the cache when it watched this run start: the
    // record as it was then, which is the record the page opens with.
    await open(run("running"));

    await waitFor(() => expect(asked).toContain(`/runs/${RUN_ID}/transcript`));
  });

  it("reads back a run that was already over when the page opened", async () => {
    const asked = answering(run("succeeded"));

    await open();

    await waitFor(() => expect(asked).toContain(`/runs/${RUN_ID}/transcript`));
  });

  it("does not read a live run back underneath its own stream", async () => {
    const asked = answering(run("running"));

    await open();

    await waitFor(() => expect(asked).toContain(`/runs/${RUN_ID}`));
    // The socket is the source while the run is live. Writing the durable copy
    // in under it would print the run a second time under itself.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked.filter((path) => path.endsWith("/transcript"))).toEqual([]);
  });
});
