import type { Run, RunStatus } from "@scriptoria/contracts";
import { CriticalityBadge } from "./CriticalityBadge";

/**
 * FA-07.4 — the state of the run at a glance, above the terminal.
 *
 * `aborted` is styled as a decision rather than a failure, because that is what
 * it is: somebody stopped it on purpose. The distinction is in the state
 * machine, in the audit trail and in FA-10.2's *last successful*, and it would
 * be odd for the one place a person looks to be the one place that blurs it.
 */
const STATES: Record<RunStatus, { label: string; dot: string; text: string }> = {
  queued: { label: "Queued", dot: "bg-ink-faint", text: "text-ink-muted" },
  starting: { label: "Starting", dot: "bg-state-running animate-pulse", text: "text-ink-muted" },
  running: { label: "Running", dot: "bg-state-running animate-pulse", text: "text-state-running" },
  succeeded: { label: "Finished", dot: "bg-state-succeeded", text: "text-state-succeeded" },
  failed: { label: "Failed", dot: "bg-state-failed", text: "text-state-failed" },
  aborted: { label: "Stopped", dot: "bg-state-aborted", text: "text-ink-muted" },
};

const REASONS: Record<string, string> = {
  exit_code: "the script exited with an error",
  connection_lost: "the connection to the script VM dropped",
  connect_failed: "the script VM could not be reached",
  start_failed: "the script could not be started",
  worker_lost: "the worker running it is gone",
  aborted_by_user: "stopped on request",
};

export function StatusLine({ run, onStop }: { run: Run; onStop: () => void }) {
  const state = STATES[run.status];
  const stoppable = run.status === "running" || run.status === "starting";

  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-surface px-6 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`size-2 shrink-0 rounded-full ${state.dot}`} />
          <span className={`text-[13px] font-semibold ${state.text}`}>{state.label}</span>
          <span className="truncate text-[13px] text-ink">{run.scriptTitle}</span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
          {run.scriptFileName} · {run.host} · started by {run.startedBy}
        </p>
      </div>

      <CriticalityBadge criticality={run.criticality} />

      <dl className="flex items-center gap-5 text-[11px]">
        <Fact label="Started" value={time(run.startedAt) ?? "—"} />
        <Fact label="Finished" value={time(run.finishedAt) ?? "—"} />
        <Fact
          label="Exit"
          value={
            run.exitCode === null
              ? run.failureReason
                ? (REASONS[run.failureReason] ?? run.failureReason)
                : "—"
              : String(run.exitCode)
          }
        />
        <Fact label="Results" value={run.resultCount === null ? "—" : String(run.resultCount)} />
      </dl>

      {stoppable ? (
        <button
          type="button"
          onClick={onStop}
          className="ml-auto rounded-[var(--radius-control)] border border-modifies px-3 py-1.5 text-[12px] font-medium text-modifies hover:bg-modifies-quiet"
        >
          Stop
        </button>
      ) : null}
    </header>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="text-ink-muted">{value}</dd>
    </div>
  );
}

function time(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
