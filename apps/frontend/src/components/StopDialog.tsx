"use client";

import { useState } from "react";
import type { Run } from "@scriptoria/contracts";
import { requiresAbortConfirmation } from "@scriptoria/core";

/**
 * FA-08.3 and ADR-003, at the one moment they are visible to a person.
 *
 * A read-only script stops on request — no confirmation, because there is
 * nothing to be careful about. A modifying one is stopped by **naming it**,
 * because the thing being prevented is stopping the wrong run out of a list,
 * and a yes/no box does not prevent that.
 *
 * The wording is deliberately plain about what stopping does not do: the
 * platform cannot roll anything back, and a half-finished modifying script
 * leaves sites in a state nobody described. Saying so here is the only honest
 * option (NFR-06).
 */
export function StopDialog({
  run,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  run: Run;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (confirmScriptName: string | undefined) => void;
}) {
  const needsName = requiresAbortConfirmation(run.criticality);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === run.scriptFileName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stop-title"
        className="w-full max-w-md rounded-[var(--radius-panel)] border border-line bg-surface p-6"
      >
        <h2 id="stop-title" className="text-sm font-semibold text-ink">
          Stop {run.scriptFileName}?
        </h2>

        {needsName ? (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              This script changes target systems. Stopping it partway leaves whatever it has
              already done in place — the platform cannot undo any of it, and it will not try.
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
              It is stopped in stages: an interrupt first, the way Ctrl-C would, then harder if
              it does not respond.
            </p>

            <label className="mt-4 block">
              <span className="text-xs font-medium text-ink">
                Type <span className="font-mono">{run.scriptFileName}</span> to confirm
              </span>
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoFocus
                spellCheck={false}
                className="mt-1.5 w-full rounded-[var(--radius-control)] border border-line bg-canvas px-3 py-2 font-mono text-[13px] text-ink"
              />
            </label>
          </>
        ) : (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            This script only reads, so it stops immediately. Anything it has already written
            stays where it is.
          </p>
        )}

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-[var(--radius-control)] bg-modifies-quiet px-3 py-2 text-xs text-modifies"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-sunken"
          >
            Let it run
          </button>
          <button
            type="button"
            disabled={busy || (needsName && !matches)}
            onClick={() => onConfirm(needsName ? typed.trim() : undefined)}
            className="rounded-[var(--radius-control)] bg-modifies px-3 py-1.5 text-[13px] font-medium text-ink-inverse disabled:opacity-40"
          >
            {busy ? "Stopping…" : "Stop it"}
          </button>
        </div>
      </div>
    </div>
  );
}
