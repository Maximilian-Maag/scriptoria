// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResultList, Run } from "@scriptoria/contracts";
import { ResultPanel } from "../src/components/ResultPanel";

/**
 * What the Results panel says when the list cannot be read (FA-09.5, issue #57).
 *
 * The panel has two statements it can make about a run's output. One is the
 * empty state, which asserts something the platform is in a position to assert:
 * the output directory was listed and there was nothing in it. The other is
 * that the list was never obtained. Rendering the first when the second is true
 * is not a cosmetic slip — it answers an outage with a negative result, and
 * FA-09.5 exists precisely so that what a run did produce stays visible.
 *
 * Real React 19 and real react-query on jsdom; the only thing faked is the
 * wire, and it is faked at `fetch`, which is where the browser would meet it.
 */

const RUN_ID = "a0d0f2e6-6f1c-4a63-9a5c-2a2d7a7f4f2e";

/** A run that has finished, which is the case where "wrote nothing" is a claim. */
function finishedRun(): Run {
  return {
    id: RUN_ID,
    areaId: "b1e1f3a7-7a2d-4b74-8b6d-3b3e8b8f5f3f",
    scriptId: "c2f2a4b8-8b3e-4c85-9c7e-4c4f9c9a6a4a",
    scriptFileName: "collect-firewall-rules.sh",
    scriptTitle: "Collect firewall rules",
    criticality: "read-only",
    status: "failed",
    trigger: "manual",
    startedBy: "jdoe",
    host: "script-vm-01",
    queuedAt: "2026-09-23T04:05:06.000Z",
    startedAt: "2026-09-23T04:05:07.000Z",
    finishedAt: "2026-09-23T04:06:30.000Z",
    exitCode: 1,
    failureReason: "exit_code",
    lastStreamId: null,
    resultCount: 0,
  };
}

function listing(files: ResultList["files"], partial = false): ResultList {
  return {
    runId: RUN_ID,
    directory: "/opt/scriptoria/export",
    files,
    totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    partial,
    collectedAt: "2026-09-23T04:06:31.000Z",
  };
}

/** Answers the panel's one call, so the test decides what the control plane said. */
function answeringResults(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function renderPanel(run: Run): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ResultPanel run={run} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the results panel when the list cannot be read", () => {
  it("says the results could not be read, and not that the run wrote nothing", async () => {
    answeringResults(500, {
      error: { code: "internal", message: "The control plane could not list the output directory" },
    });

    renderPanel(finishedRun());

    expect(await screen.findByText("Could not read the results")).toBeTruthy();
    expect(screen.getByText("The control plane could not list the output directory")).toBeTruthy();

    // The empty state makes a claim about the run. A failed call is not
    // evidence for it, so neither half of it may appear.
    expect(screen.queryByText("No result files")).toBeNull();
    expect(screen.queryByText(/wrote nothing into its output directory/)).toBeNull();
  });

  it("still says the run wrote nothing when the list really is empty", async () => {
    answeringResults(200, listing([]));

    renderPanel(finishedRun());

    expect(await screen.findByText("No result files")).toBeTruthy();
    expect(screen.queryByText(/Could not read the results/)).toBeNull();
  });

  it("still lists the files of a failed run (FA-09.5)", async () => {
    answeringResults(
      200,
      listing([
        {
          path: "rules.csv",
          name: "rules.csv",
          sizeBytes: 2048,
          modifiedAt: "2026-09-23T04:06:00.000Z",
          contentType: "text/csv",
          previewable: true,
        },
      ]),
    );

    renderPanel(finishedRun());

    expect(await screen.findByText("rules.csv")).toBeTruthy();
    expect(screen.queryByText("No result files")).toBeNull();
    expect(screen.queryByText(/Could not read the results/)).toBeNull();
  });
});
