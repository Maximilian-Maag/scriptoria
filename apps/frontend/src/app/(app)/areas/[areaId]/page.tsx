"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Script } from "@scriptoria/contracts";
import { ApiFailure, api } from "@/lib/api";
import { AreaTabs } from "@/components/AreaTabs";
import { CriticalityBadge } from "@/components/CriticalityBadge";

/**
 * FA-03 and FA-04 — the scripts of one area, and the two steps that start one.
 *
 * Selection and start are deliberately separate (FA-04.1): a script is opened,
 * read and then started, rather than run by a single click in a list. What is
 * read is the script's **header** — FA-03.4 is explicit that the body is not
 * part of the overview, because real scripts run to thousands of lines and
 * their content is the script owner's business (NFR-06).
 */
export default function AreaPage({ params }: { params: Promise<{ areaId: string }> }) {
  const { areaId } = use(params);
  const router = useRouter();
  const client = useQueryClient();

  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scripts = useQuery({
    queryKey: ["scripts", areaId],
    queryFn: () => api.scripts(areaId),
  });

  const rescan = useMutation({
    mutationFn: () => api.rescan(areaId),
    onSuccess: (fresh) => client.setQueryData(["scripts", areaId], fresh),
  });

  const start = useMutation({
    mutationFn: (scriptId: string) =>
      api.startRun({
        scriptId,
        // The PTY is opened at the size of the window the operator is looking
        // at, so a script that formats a table formats it for the right width.
        cols: Math.max(20, Math.min(500, Math.floor((window.innerWidth - 420) / 8))),
        rows: 30,
      }),
    onSuccess: (run) => router.push(`/runs/${run.id}`),
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not start the script"),
  });

  const chosen = scripts.data?.find((script) => script.id === selected) ?? null;

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="border-b border-line px-6 py-4">
          <AreaTabs areaId={areaId} />
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-ink-faint">
              {scripts.data ? `${scripts.data.length} in this area` : "Reading the script VM…"}
            </p>
            <button
              type="button"
              onClick={() => rescan.mutate()}
              disabled={rescan.isPending}
              className="rounded-[var(--radius-control)] border border-line px-2.5 py-1.5 text-[11px] text-ink-muted hover:bg-surface-sunken disabled:opacity-60"
            >
              {rescan.isPending ? "Reading…" : "Rescan"}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {scripts.isError ? (
            <Notice
              title="Could not read the script directory"
              detail={
                scripts.error instanceof ApiFailure
                  ? scripts.error.message
                  : "The script VM did not answer."
              }
            />
          ) : null}

          {scripts.data?.length === 0 ? (
            <Notice
              title="This area has no scripts"
              detail="Nothing was found in the directory mapped to this area. That is a fact about the script VM, not a fault here."
            />
          ) : null}

          <ul className="space-y-2">
            {scripts.data?.map((script) => (
              <ScriptRow
                key={script.id}
                script={script}
                selected={script.id === selected}
                onSelect={() => {
                  setSelected(script.id);
                  setError(null);
                }}
              />
            ))}
          </ul>
        </div>
      </section>

      {chosen ? (
        <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface">
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">{chosen.title}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{chosen.fileName}</p>
          </div>

          <div className="space-y-5 px-5 py-4">
            <div className="flex flex-wrap gap-1.5">
              <CriticalityBadge
                criticality={chosen.criticality}
                overridden={chosen.criticalityOverridden}
              />
              {chosen.interactive ? (
                <span className="rounded-full bg-accent-quiet px-2 py-0.5 text-[11px] font-medium text-accent">
                  Asks questions
                </span>
              ) : null}
            </div>

            <Field label="What it does">
              {chosen.description || (
                /* ADR-004: an unreadable or absent header must never keep a
                   script out of the catalog. It is shown as undeclared. */
                <span className="text-ink-faint">
                  This script declares no description of itself.
                </span>
              )}
            </Field>

            <Field label="On the script VM">
              <span className="font-mono text-[11px] break-all">{chosen.absolutePath}</span>
            </Field>

            {chosen.outputPath ? (
              <Field label="Writes its results to">
                <span className="font-mono text-[11px] break-all">{chosen.outputPath}</span>
              </Field>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="rounded-[var(--radius-control)] bg-modifies-quiet px-3 py-2 text-xs text-modifies"
              >
                {error}
              </p>
            ) : null}

            {chosen.present ? null : (
              /* FA-03.3. The catalogue keeps a script that has gone from the
                 script VM so that its run history stays readable, and says so
                 here rather than offering a start that could only fail. */
              <p className="rounded-[var(--radius-control)] bg-surface-sunken px-3 py-2 text-xs leading-relaxed text-ink-muted">
                The most recent scan did not find {chosen.fileName} in the script directory. It is
                listed for its run history, and cannot be started. Rescan, or check the script VM.
              </p>
            )}

            <button
              type="button"
              onClick={() => start.mutate(chosen.id)}
              disabled={start.isPending || !chosen.present}
              className="w-full rounded-[var(--radius-control)] bg-accent px-3 py-2 text-[13px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-60"
            >
              {chosen.present
                ? start.isPending
                  ? "Starting…"
                  : "Start this script"
                : "Not on the script VM"}
            </button>

            <p className="text-[11px] leading-relaxed text-ink-faint">
              It starts with no parameters. Anything it needs, it asks for in the terminal once it
              is running.
            </p>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function ScriptRow({
  script,
  selected,
  onSelect,
}: {
  script: Script;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full rounded-[var(--radius-panel)] border px-4 py-3 text-left ${
          selected
            ? "border-accent bg-accent-quiet/40"
            : "border-line bg-surface hover:border-line-strong"
        } ${script.present ? "" : "opacity-70"}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-ink">{script.title}</p>
            <p className="truncate font-mono text-[11px] text-ink-faint">{script.fileName}</p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            <CriticalityBadge
              criticality={script.criticality}
              overridden={script.criticalityOverridden}
            />
            {script.present ? null : (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                Not on the VM
              </span>
            )}
          </span>
        </div>
        {script.description ? (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-muted">
            {script.description}
          </p>
        ) : null}
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{label}</p>
      <div className="mt-1 text-[13px] leading-relaxed text-ink-muted">{children}</div>
    </div>
  );
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-3 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{detail}</p>
    </div>
  );
}
