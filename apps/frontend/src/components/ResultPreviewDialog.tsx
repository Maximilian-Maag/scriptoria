"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiFailure, api } from "@/lib/api";

/**
 * FA-09.1 and FA-09.4 — **display** and **copy**, the two forms of result
 * provisioning that are not a download.
 *
 * The requirement is explicit that download is only one of three, and this is
 * the other two: content read on screen, and content put on the clipboard to
 * carry into a ticket or another system without a file ever reaching a disk.
 * For the common case — a report of a few kilobytes that somebody wants to
 * paste into a change record — saving it first and opening it second is exactly
 * the handwork FA-09.6 is about abolishing.
 *
 * Capped by the control plane. A truncated preview says so plainly and points
 * at the download, because a preview that quietly shows the first quarter of a
 * file is worse than one that admits it.
 */
export function ResultPreviewDialog({
  runId,
  path,
  onClose,
}: {
  runId: string;
  path: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const preview = useQuery({
    queryKey: ["preview", runId, path],
    queryFn: () => api.resultPreview(runId, path),
  });

  const copy = async (): Promise<void> => {
    if (!preview.data) return;
    try {
      await navigator.clipboard.writeText(preview.data.content);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // The clipboard API is refused outside a secure context, which a plain
      // http development origin is. Saying so beats a button that does nothing.
      setCopyFailed(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-[var(--radius-panel)] border border-line bg-surface"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <h2 id="preview-title" className="truncate font-mono text-[13px] text-ink">
              {path}
            </h2>
            {preview.data ? (
              <p className="mt-0.5 text-[11px] text-ink-faint">
                {preview.data.contentType} · {size(preview.data.sizeBytes)}
                {preview.data.truncated ? " · showing the beginning only" : ""}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              disabled={!preview.data}
              className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 text-[11px] text-ink-muted hover:bg-surface-sunken disabled:opacity-50"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              href={api.resultFileUrl(runId, path)}
              download
              className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 text-[11px] text-ink-muted hover:bg-surface-sunken"
            >
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--radius-control)] px-2.5 py-1 text-[11px] text-ink-muted hover:bg-surface-sunken"
            >
              Close
            </button>
          </div>
        </header>

        {copyFailed ? (
          <p className="border-b border-line bg-undeclared-quiet px-5 py-2 text-[11px] text-undeclared">
            The browser refused clipboard access — that happens on a plain http origin. Select the
            text and copy it, or use the download.
          </p>
        ) : null}

        {preview.data?.truncated ? (
          <p className="border-b border-line bg-undeclared-quiet px-5 py-2 text-[11px] text-undeclared">
            This file is longer than the preview shows. Copying takes only what is on screen —
            download it for the whole thing.
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto bg-surface-sunken">
          {preview.isLoading ? (
            <p className="px-5 py-4 text-[12px] text-ink-faint">Reading it off the script VM…</p>
          ) : preview.isError ? (
            <p className="px-5 py-4 text-[12px] text-modifies">
              {preview.error instanceof ApiFailure
                ? preview.error.message
                : "The file could not be read."}
            </p>
          ) : preview.data?.content === "" ? (
            <p className="px-5 py-4 text-[12px] text-ink-faint">
              This file is empty. That is a fact about the file, not a failure here.
            </p>
          ) : (
            /* `pre` and not a terminal: a result is a file, and this is the one
               place in the product that renders one as text. FA-07.3's terminal
               selection is a different surface with a different job. */
            <pre className="px-5 py-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink">
              {preview.data?.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
