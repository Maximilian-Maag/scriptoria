"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ResultList, Run } from "@scriptoria/contracts";
import { ApiFailure, api } from "@/lib/api";
import { ResultPreviewDialog } from "./ResultPreviewDialog";

/**
 * FA-09 — what the run wrote, beside the terminal it wrote it from.
 *
 * The distinction this panel exists to keep is the one the requirements are
 * emphatic about: the **terminal** is the live byte stream of the process; a
 * **result** is a file in a defined directory. Two channels, two lifecycles,
 * two panels.
 *
 * All three forms of provisioning FA-09 names are here, because the requirement
 * is explicit that download is only one of them: **display** and **copy** are
 * the preview, **download** is the link, and the ZIP is how the set of them
 * leaves at once (FA-09.3).
 *
 * Shown for failed and aborted runs exactly as for successful ones (FA-09.5):
 * the exit code ends the run, it does not decide whether what the run produced
 * is worth seeing. A partial result is evidence about what the run managed to
 * do before it stopped.
 *
 * FA-09.5 also decides what the panel may *not* say. "This run wrote nothing"
 * is a claim about the run, and it is only available once the output directory
 * has actually been read — so a failed results call is reported as a failed
 * call, not as an empty run (issue #57).
 */
export function ResultPanel({ run }: { run: Run }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const results = useQuery({
    queryKey: ["results", run.id],
    queryFn: () => api.results(run.id),
    refetchInterval: (query) => resultsRefetchInterval(query.state.data),
  });

  const list = results.data;
  const files = list?.files ?? [];

  const archive = useMutation({
    mutationFn: (paths: string[]) => api.resultArchive(run.id, paths),
    onSuccess: (blob) => {
      // The one download in this interface assembled in the tab, because a
      // plain link cannot carry the selection as a POST body. Revoked straight
      // after the click so the blob does not sit in memory for the session.
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = archiveName(run);
      anchor.click();
      URL.revokeObjectURL(url);
      setError(null);
    },
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "The archive could not be built"),
  });

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const chosen = files.filter((file) => selected.has(file.path));
  const wholeSet = chosen.length === 0;

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-semibold text-ink">Results</h2>
          {files.length > 0 ? (
            <span className="text-[10px] text-ink-faint">
              {files.length} {files.length === 1 ? "file" : "files"} · {size(list?.totalBytes ?? 0)}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={list?.directory}>
          {list?.directory ?? "…"}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.isError ? (
          <ErrorState
            detail={
              results.error instanceof ApiFailure
                ? results.error.message
                : "The control plane did not answer."
            }
          />
        ) : files.length > 0 ? (
          <ul className="divide-y divide-line">
            {files.map((file) => (
              <li key={file.path} className="px-5 py-2.5">
                <div className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(file.path)}
                    onChange={() => toggle(file.path)}
                    aria-label={`Include ${file.name} in the archive`}
                    className="mt-1 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink" title={file.path}>
                      {file.name}
                    </p>
                    <p className="truncate text-[10px] text-ink-faint">
                      {file.path !== file.name ? `${file.path} · ` : ""}
                      {size(file.sizeBytes)}
                    </p>
                    <div className="mt-1.5 flex gap-2">
                      {/* FA-09.1 / FA-09.4. Offered only where the content is
                          text: a preview of a tarball helps nobody. */}
                      {file.previewable ? (
                        <button
                          type="button"
                          onClick={() => setPreviewing(file.path)}
                          className="text-[11px] text-accent underline-offset-2 hover:underline"
                        >
                          Open
                        </button>
                      ) : null}
                      {/* A plain link, not a fetch: the browser saves the file
                          as the stream arrives instead of assembling it. */}
                      <a
                        href={api.resultFileUrl(run.id, file.path)}
                        download={file.name}
                        className="text-[11px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                      >
                        Download
                      </a>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState finished={run.finishedAt !== null} />
        )}
      </div>

      {error ? (
        <p
          role="alert"
          className="border-t border-line bg-modifies-quiet px-5 py-2 text-[11px] text-modifies"
        >
          {error}
        </p>
      ) : null}

      {files.length > 0 ? (
        <div className="border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={() => archive.mutate(chosen.map((file) => file.path))}
            disabled={archive.isPending}
            className="w-full rounded-[var(--radius-control)] bg-accent px-3 py-2 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-60"
          >
            {archive.isPending
              ? "Building the archive…"
              : wholeSet
                ? `Download all ${files.length} as ZIP`
                : `Download ${chosen.length} selected as ZIP`}
          </button>
          {/* FA-09.3 is about hundreds of files across dozens of sites. Saying
              what the button will actually do beats a silent default. */}
          <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
            {wholeSet
              ? "Nothing ticked, so the whole result set goes in."
              : "Only the ticked files go in."}
          </p>
        </div>
      ) : null}

      {list?.partial ? (
        <p className="border-t border-line px-5 py-2 text-[11px] text-ink-faint">
          The run is still going. This list is what exists so far.
        </p>
      ) : null}

      {previewing ? (
        <ResultPreviewDialog runId={run.id} path={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
    </aside>
  );
}

/**
 * A read that failed, said as a failure (issue #57).
 *
 * `EmptyState` below is a claim about the run — that the output directory was
 * listed and it was empty — and FA-09.5 is the requirement that keeps results
 * visible for a failed run. A failed call is not evidence for that claim:
 * rendering it as "This run wrote nothing into its output directory" reports an
 * outage as a negative result, and the operator concludes the script produced
 * nothing when in fact nobody managed to ask. The area page and the run history
 * answer a failed read the same way.
 */
function ErrorState({ detail }: { detail: string }) {
  return (
    <div className="px-5 py-4">
      <p className="text-[13px] text-ink">Could not read the results</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{detail}</p>
    </div>
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

/**
 * How often the results list is asked for again.
 *
 * FA-09.1 rests on this, and the obvious rule — ask while the run is live — gets
 * it exactly wrong. The collector lists the output directory when the run
 * *ends* (`resultService.listResults` reads only what it recorded, and it
 * records nothing before the end), so the fetch that matters is the one after
 * the last status change, and an interval driven by the run cancels that very
 * fetch: the run turns terminal, the interval flips to `false`, and the pending
 * tick is cleared instead of issued. The panel is then left holding the
 * pre-collection answer, which for a run that has just written four files is an
 * empty list — and the empty state says so in words: "This run wrote nothing
 * into its output directory".
 *
 * The list itself says which state it is in: `partial` is the control plane's
 * name for "the run has not ended" (FA-09.3). Polling on that answer rather
 * than on the run's clock keeps asking until the answer is final, and stops
 * there — which is one fetch more than before, in the one case where before
 * there was none.
 */
export function resultsRefetchInterval(list: ResultList | undefined): number | false {
  return list?.partial === false ? false : 5_000;
}

/** Matches what the control plane names the archive, so the two agree. */
function archiveName(run: Run): string {
  const base = run.scriptFileName.replace(/\.[^.]+$/, "") || "results";
  const stamp = new Date(run.queuedAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-${stamp}.zip`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
