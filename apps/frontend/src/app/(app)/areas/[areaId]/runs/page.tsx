"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Run, RunStatus } from "@scriptoria/contracts";
import { isTerminalStatus } from "@scriptoria/contracts";
import { ApiFailure, api } from "@/lib/api";
import { AreaTabs } from "@/components/AreaTabs";
import { CriticalityBadge } from "@/components/CriticalityBadge";

/**
 * FA-05.4 and FA-09.5 — what happened in this area, and the way back into a run
 * that is already over.
 *
 * Without this view the product could start a script and then lose it: the
 * console is reachable only by having just started something, so a run whose
 * tab was closed was gone, and with it the results FA-09.5 insists stay visible
 * *especially* for a failed run. A run is history, and history has to be
 * findable to be worth recording.
 *
 * Failure is not filtered out or folded away here. A run that failed is the one
 * somebody is most likely to have come looking for.
 */

const PAGE_SIZE = 50;

const STATES: Record<RunStatus, { label: string; dot: string; text: string }> = {
  queued: { label: "Queued", dot: "bg-ink-faint", text: "text-ink-muted" },
  starting: { label: "Starting", dot: "bg-state-running animate-pulse", text: "text-ink-muted" },
  running: { label: "Running", dot: "bg-state-running animate-pulse", text: "text-state-running" },
  succeeded: { label: "Finished", dot: "bg-state-succeeded", text: "text-state-succeeded" },
  failed: { label: "Failed", dot: "bg-state-failed", text: "text-state-failed" },
  aborted: { label: "Stopped", dot: "bg-state-aborted", text: "text-ink-muted" },
};

/** The states worth filtering by, in the order somebody would reach for them. */
const FILTERS: { label: string; status: RunStatus | undefined }[] = [
  { label: "All", status: undefined },
  { label: "Running", status: "running" },
  { label: "Failed", status: "failed" },
  { label: "Stopped", status: "aborted" },
  { label: "Finished", status: "succeeded" },
];

export default function AreaRunsPage({ params }: { params: Promise<{ areaId: string }> }) {
  const { areaId } = use(params);
  const [status, setStatus] = useState<RunStatus | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const runs = useQuery({
    queryKey: ["runs", areaId, status ?? "all", offset],
    queryFn: () => api.runs({ areaId, limit: PAGE_SIZE, offset, ...(status ? { status } : {}) }),
    // A list holding anything live keeps itself current; one that is all
    // history is left alone, because history does not change.
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => !isTerminalStatus(run.status)) ? 4_000 : false,
  });

  const total = runs.data?.total ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-line px-6 py-4">
        <AreaTabs areaId={areaId} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-ink-faint">
            {runs.isLoading ? "Loading…" : `${total} ${total === 1 ? "run" : "runs"}`}
          </p>
          <div className="flex gap-1">
            {FILTERS.map((filter) => (
              <button
                key={filter.label}
                type="button"
                onClick={() => {
                  setStatus(filter.status);
                  setOffset(0);
                }}
                className={`rounded-[var(--radius-control)] px-2.5 py-1 text-[11px] ${
                  status === filter.status
                    ? "bg-accent-quiet font-medium text-accent"
                    : "text-ink-muted hover:bg-surface-sunken"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {runs.isError ? (
          <Notice
            title="Could not load the run history"
            detail={
              runs.error instanceof ApiFailure
                ? runs.error.message
                : "The control plane did not answer."
            }
          />
        ) : null}

        {runs.data?.items.length === 0 ? (
          <Notice
            title={status ? "Nothing matches that filter" : "Nothing has been run here yet"}
            detail={
              status
                ? "No run in this area is in that state."
                : "Every script started in this area shows up here afterwards, whether it succeeded, failed or was stopped."
            }
          />
        ) : null}

        <ul className="space-y-2">
          {runs.data?.items.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>

        {total > PAGE_SIZE ? (
          <div className="mt-4 flex items-center justify-between text-[11px] text-ink-muted">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 hover:bg-surface-sunken disabled:opacity-40"
            >
              Newer
            </button>
            <span>
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 hover:bg-surface-sunken disabled:opacity-40"
            >
              Older
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  const state = STATES[run.status];

  return (
    <li>
      <Link
        href={`/runs/${run.id}`}
        className="block rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3 hover:border-line-strong"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`size-2 shrink-0 rounded-full ${state.dot}`} />
              <span className={`text-[11px] font-semibold ${state.text}`}>{state.label}</span>
              <span className="truncate text-[13px] font-medium text-ink">{run.scriptTitle}</span>
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
              {run.scriptFileName} · started by {run.startedBy}
              {run.trigger === "scheduled" ? " · scheduled" : ""}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {/* The criticality as it was at start time — a later override must
                not rewrite what the operator was warned about. */}
            <CriticalityBadge criticality={run.criticality} />
            <div className="text-right">
              <p className="text-[11px] text-ink-muted">{when(run)}</p>
              <p className="text-[10px] text-ink-faint">
                {duration(run)}
                {/* FA-09.5: an output exists whether or not the run succeeded,
                    so the count is shown for a failed run exactly as for a
                    successful one. */}
                {run.resultCount === null
                  ? ""
                  : ` · ${run.resultCount} ${run.resultCount === 1 ? "file" : "files"}`}
              </p>
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

function when(run: Run): string {
  const at = new Date(run.startedAt ?? run.queuedAt);
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function duration(run: Run): string {
  if (!run.startedAt) return "not started";
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-3 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{detail}</p>
    </div>
  );
}
