"use client";

import { useQuery } from "@tanstack/react-query";
import type { Run } from "@scriptoria/contracts";
import { api } from "@/lib/api";

/**
 * FA-09 — what the run wrote, beside the terminal it wrote it from.
 *
 * The distinction this panel exists to keep is the one the product owner
 * insisted on: the **terminal** is the live byte stream of the process; a
 * **result** is a file in a defined directory. Two channels, two lifecycles,
 * two panels.
 *
 * Shown for failed and aborted runs exactly as for successful ones (FA-09.5):
 * the exit code ends the run, it does not decide whether what the run produced
 * is worth seeing. A partial result is evidence about what the run managed to
 * do before it stopped.
 */
export function ResultPanel({ run }: { run: Run }) {
  const results = useQuery({
    queryKey: ["results", run.id],
    queryFn: () => api.results(run.id),
    // While the run is going there is nothing to collect yet — the collector
    // lists the output directory when the run ends.
    refetchInterval: run.finishedAt ? false : 5_000,
  });

  const list = results.data;

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h2 className="text-[13px] font-semibold text-ink">Results</h2>
        <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={list?.directory}>
          {list?.directory ?? "…"}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list && list.files.length > 0 ? (
          <ul className="divide-y divide-line">
            {list.files.map((file) => (
              <li key={file.path} className="px-5 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-ink" title={file.path}>
                      {file.name}
                    </p>
                    <p className="truncate text-[10px] text-ink-faint">
                      {file.path !== file.name ? `${file.path} · ` : ""}
                      {size(file.sizeBytes)}
                    </p>
                  </div>
                  {/* A plain link, not a fetch: the browser saves the file as
                      the stream arrives instead of assembling it in the tab. */}
                  <a
                    href={api.resultFileUrl(run.id, file.path)}
                    download={file.name}
                    className="shrink-0 rounded-[var(--radius-control)] border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-sunken"
                  >
                    Download
                  </a>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState finished={run.finishedAt !== null} />
        )}
      </div>

      {list?.partial ? (
        <p className="border-t border-line px-5 py-2 text-[11px] text-ink-faint">
          The run is still going. This list is what exists so far.
        </p>
      ) : null}
    </aside>
  );
}

function EmptyState({ finished }: { finished: boolean }) {
  return (
    <div className="px-5 py-4">
      <p className="text-[13px] text-ink">{finished ? "No result files" : "Nothing yet"}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
        {finished
          ? "This run wrote nothing into its output directory. Plenty of scripts do not — the terminal is where their work shows."
          : "The output directory is read when the run ends."}
      </p>
    </div>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
