"use client";

import { use, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTerminalStatus } from "@scriptoria/contracts";
import { ApiFailure, api } from "@/lib/api";
import { StatusLine } from "@/components/StatusLine";
import { TerminalView, isLive } from "@/components/TerminalView";
import { ResultPanel } from "@/components/ResultPanel";
import { StopDialog } from "@/components/StopDialog";

/**
 * The console: NFR-13's layout, with the three things it names in the places it
 * names them. Status line at the top, terminal in the middle, results to the
 * right.
 *
 * The run record is polled while the run is live, and the terminal bytes arrive
 * on their own socket. Those are two channels on purpose (FA-07): the status
 * line is *about* the run, the terminal *is* the process.
 */
export default function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const client = useQueryClient();

  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Polled while it is live and left alone once it is not. A finished run
      // does not change, and a page that keeps asking is a page that will keep
      // asking for as long as somebody leaves the tab open.
      return status && isTerminalStatus(status) ? false : 2_000;
    },
  });

  const live = run.data ? isLive(run.data.status) : false;

  /**
   * Whether this run was already over when the page opened.
   *
   * It decides where the terminal's content comes from, and the two sources
   * must never both be used: a run watched from its start has every byte from
   * the socket already, and writing the transcript in afterwards would print
   * the whole run a second time under itself.
   */
  const openedFinished = useRef<boolean | null>(null);
  if (openedFinished.current === null && run.data) {
    openedFinished.current = !isLive(run.data.status);
  }

  // FA-07.2 — a run that is already over is read back from the durable copy of
  // its terminal. The live stream is capped and expires; this does not.
  const transcript = useQuery({
    queryKey: ["transcript", runId],
    queryFn: () => api.transcript(runId),
    enabled: openedFinished.current === true,
  });

  const bytes = useMemo(() => {
    const encoded = transcript.data?.contentBase64;
    if (!encoded) return null;
    const binary = atob(encoded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }, [transcript.data?.contentBase64]);

  const abort = useMutation({
    mutationFn: (confirmScriptName: string | undefined) =>
      api.abortRun(runId, confirmScriptName ? { confirmScriptName } : {}),
    onSuccess: async () => {
      setStopping(false);
      setStopError(null);
      await client.invalidateQueries({ queryKey: ["run", runId] });
    },
    onError: (cause) =>
      setStopError(cause instanceof ApiFailure ? cause.message : "Could not stop the run"),
  });

  if (run.isError) {
    return (
      <div className="flex h-full items-center justify-center p-10">
        <p className="text-[13px] text-ink-muted">
          {run.error instanceof ApiFailure ? run.error.message : "This run is not available."}
        </p>
      </div>
    );
  }

  if (!run.data) {
    return (
      <div className="flex h-full items-center justify-center p-10">
        <p className="text-[13px] text-ink-faint">Opening the run…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <StatusLine run={run.data} onStop={() => setStopping(true)} />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 p-4">
          <TerminalView
            runId={runId}
            live={live}
            transcript={bytes}
            onStatus={() => void client.invalidateQueries({ queryKey: ["run", runId] })}
          />
        </div>

        <ResultPanel run={run.data} />
      </div>

      {stopping ? (
        <StopDialog
          run={run.data}
          busy={abort.isPending}
          error={stopError}
          onCancel={() => {
            setStopping(false);
            setStopError(null);
          }}
          onConfirm={(name) => abort.mutate(name)}
        />
      ) : null}
    </div>
  );
}
