// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Run } from "@scriptoria/contracts";
import { QUERY_DEFAULTS } from "../src/lib/query";
import RunPage from "../src/app/(app)/runs/[runId]/page";

/**
 * FA-07.2 — a run that is over is read from the durable copy of its terminal.
 *
 * The console decides *once*, when it opens, whether the terminal's bytes come
 * from the socket or from the transcript on disk. It decides from the run
 * record it has at that moment — and if that record is the one the visit that
 * watched this run start left behind, it says `running`. The console concludes
 * it is watching a live run, attaches to a stream that is capped and expires,
 * and never reads the transcript back underneath it: FA-07.2's read-back
 * happens to look right while the run is recent (Redis still has the stream and
 * replays it) and is empty afterwards, which is the whole point of the
 * requirement.
 *
 * The tests run with the interface's own query defaults, and that is
 * load-bearing. `staleTime: 10_000` is longer than a run takes to finish, so on
 * the way back the cached record is *fresh* and react-query has no reason to
 * fetch another one — a test client with react-query's defaults refetches on
 * mount, decides correctly, passes, and tests a different application. That
 * difference is exactly how this reached CI.
 *
 * Real React and real react-query on jsdom; the wire is faked at `fetch`, which
 * is where the browser would meet it.
 */

/**
 * What the page hands the view: the decision under test, and the bytes it
 * decided to show. Recorded rather than rendered — xterm wants a terminal with
 * a size to measure, and what is under test here is which source the page
 * chose, not what it printed.
 */
const handedToTerminal: { live: boolean; transcript: Uint8Array | null }[] = [];

vi.mock("../src/components/TerminalView", async (importOriginal) => {
  // `isLive` — the rule the page reads its decision through — is kept real
  // rather than restated here.
  const actual = await importOriginal<typeof import("../src/components/TerminalView")>();
  return {
    ...actual,
    TerminalView: (props: { live: boolean; transcript: Uint8Array | null }) => {
      handedToTerminal.push(props);
      return null;
    },
  };
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
function answering(answer: Run, transcript = "UmVhZGluZyBpbnRlcmZhY2Vz"): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/api\/proxy/, "");
      asked.push(path);
      if (path === `/runs/${RUN_ID}`) return json(answer);
      if (path === `/runs/${RUN_ID}/transcript`)
        return json({ contentBase64: transcript, truncated: false });
      return new Response("", { status: 404 });
    }),
  );
  return asked;
}

async function open(seeded?: Run): Promise<QueryClient> {
  // The interface's own defaults, `staleTime` included: see the note above.
  const client = new QueryClient({ defaultOptions: { queries: QUERY_DEFAULTS } });
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
  handedToTerminal.length = 0;
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

  it("shows an empty terminal for a run that printed nothing, and does not call it an error (FA-07.5)", async () => {
    // A script that produced no output and a console that failed to read the
    // output look the same on a black screen. FA-07.5 is the first of those: the
    // durable copy *is* read — the assertion below is that it was asked for —
    // and it is empty, which is a fact about the run rather than a failure of
    // the read. Two things make that legible: the console decided to read the
    // run back instead of attaching a socket to it, and the status line above
    // the silence still says the run finished.
    const asked = answering(run("succeeded"), "");

    await open();

    await waitFor(() => expect(asked).toContain(`/runs/${RUN_ID}/transcript`));
    expect(handedToTerminal.at(-1)?.live, "a finished run is read back, not streamed").toBe(false);

    const shown = document.body.textContent ?? "";
    expect(shown).toContain("Finished");
    expect(shown).not.toMatch(/could not|not available|failed to|went wrong|error/i);
  });
});
