"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { auditActionSchema, type AuditAction, type AuditEntry } from "@scriptoria/contracts";
import { ApiFailure, api } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * FA-12 — what the platform recorded, on screen.
 *
 * Everything shown here was already being written: every login, every run,
 * every download, every change to an area, a path mapping or an entitlement.
 * Until this screen existed the log could only be read with psql, which means
 * that in practice it was not read — and an audit trail nobody can read is a
 * compliance artefact rather than a control (NFR-05).
 *
 * The filters are the questions actually asked of a log like this: *what did
 * this account do*, *who touched this area*, *what happened around this time*,
 * *what has been downloaded*. They are server-side, because the interesting
 * window is usually months old and further back than any page this view holds.
 *
 * Nothing here is editable, and nothing is ever hidden: a failed login is as
 * visible as a successful one, and an entry whose area has since been deleted
 * stays — the areaId goes null, the subject keeps the name it had.
 */

const PAGE_SIZE = 100;

/**
 * Every action, in four groups. The grouping is the reader's, not the
 * database's: the log stores a flat vocabulary, and somebody reading it is
 * asking about access, runs, results or configuration.
 */
const ACTIONS: Record<AuditAction, { label: string; group: string }> = {
  login_succeeded: { label: "Signed in", group: "Access" },
  login_failed: { label: "Sign-in failed", group: "Access" },
  logout: { label: "Signed out", group: "Access" },

  run_started: { label: "Run started", group: "Runs" },
  run_aborted: { label: "Run stopped", group: "Runs" },
  run_finished: { label: "Run finished", group: "Runs" },

  result_downloaded: { label: "Result downloaded", group: "Results" },
  result_archive_downloaded: { label: "Result set downloaded", group: "Results" },

  area_created: { label: "Area created", group: "Administration" },
  area_updated: { label: "Area changed", group: "Administration" },
  area_deleted: { label: "Area deleted", group: "Administration" },
  source_added: { label: "Path mapped", group: "Administration" },
  source_removed: { label: "Path unmapped", group: "Administration" },
  entitlement_granted: { label: "Group entitled", group: "Administration" },
  entitlement_revoked: { label: "Entitlement revoked", group: "Administration" },
  script_criticality_overridden: { label: "Criticality overridden", group: "Administration" },
  schedule_updated: { label: "Schedule changed", group: "Administration" },
};

const GROUPS = ["Access", "Runs", "Results", "Administration"];

interface Filters {
  actor: string;
  action: AuditAction | "";
  areaId: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { actor: "", action: "", areaId: "", from: "", to: "" };

export default function AdminAuditPage() {
  const session = useSession();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [offset, setOffset] = useState(0);

  const isRoot = session.data?.user?.role === "root";

  // The area names, so a row says which area rather than which uuid. The same
  // call the areas screen makes, and cached under the same key.
  const areas = useQuery({
    queryKey: ["admin", "areas"],
    queryFn: () => api.admin.areas(),
    enabled: isRoot,
  });

  const entries = useQuery({
    queryKey: ["admin", "audit", filters, offset],
    queryFn: () =>
      api.admin.audit({
        limit: PAGE_SIZE,
        offset,
        ...(filters.actor ? { actor: filters.actor } : {}),
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.areaId ? { areaId: filters.areaId } : {}),
        // `datetime-local` has no timezone; the contract wants one. The browser
        // reads the field in the reader's zone, which is the zone they typed it
        // in, so converting here is the only place the two have to agree.
        ...(filters.from ? { from: new Date(filters.from).toISOString() } : {}),
        ...(filters.to ? { to: new Date(filters.to).toISOString() } : {}),
      }),
    enabled: isRoot,
  });

  if (session.isLoading) return null;

  if (!isRoot) {
    return (
      <Centered
        title="The audit log is the root account's"
        detail="Your account sees the areas, scripts, runs and results its groups reach. Who did what across the whole platform is a different question, and it is answered for the root account only."
      />
    );
  }

  const areaName = (id: string | null): string | null =>
    id ? (areas.data?.find((area) => area.id === id)?.name ?? "Deleted area") : null;

  const set = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
  };

  const total = entries.data?.total ?? 0;
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-line px-6 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-sm font-semibold text-ink">Audit log</h1>
            <p className="text-[11px] text-ink-faint">
              {entries.isLoading
                ? "Loading…"
                : `${total.toLocaleString()} ${total === 1 ? "entry" : "entries"}${
                    filtered ? " match" : " recorded"
                  }`}
            </p>
          </div>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setFilters(NO_FILTERS);
                setOffset(0);
              }}
              className="text-[11px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          {/* An exact account name, not a search: the column is indexed and
              matched with `=`, and the names are a closed set somebody reading
              this screen already knows. Hence the placeholder showing a whole
              one rather than a fragment. */}
          <Field label="Account">
            <input
              value={filters.actor}
              onChange={(event) => set({ actor: event.target.value })}
              placeholder="platform.root"
              className="w-44 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint"
            />
          </Field>

          <Field label="Action">
            <select
              value={filters.action}
              onChange={(event) => set({ action: event.target.value as AuditAction | "" })}
              className="w-52 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-[11px] text-ink"
            >
              <option value="">Everything</option>
              {GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {auditActionSchema.options
                    .filter((action) => ACTIONS[action].group === group)
                    .map((action) => (
                      <option key={action} value={action}>
                        {ACTIONS[action].label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field label="Area">
            <select
              value={filters.areaId}
              onChange={(event) => set({ areaId: event.target.value })}
              className="w-44 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-[11px] text-ink"
            >
              <option value="">Every area</option>
              {(areas.data ?? []).map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="From">
            <input
              type="datetime-local"
              value={filters.from}
              onChange={(event) => set({ from: event.target.value })}
              className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-[11px] text-ink"
            />
          </Field>

          <Field label="To">
            <input
              type="datetime-local"
              value={filters.to}
              onChange={(event) => set({ to: event.target.value })}
              className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1 text-[11px] text-ink"
            />
          </Field>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {entries.isError ? (
          <Notice
            title="Could not load the audit log"
            detail={
              entries.error instanceof ApiFailure
                ? entries.error.message
                : "The control plane did not answer."
            }
          />
        ) : null}

        {entries.data?.items.length === 0 ? (
          <Notice
            title={filtered ? "Nothing matches those filters" : "Nothing has been recorded yet"}
            detail={
              filtered
                ? "No entry in the log matches all of them. Widening the time window is usually what is needed."
                : "Every sign-in, run, download and administrative change shows up here from the moment it happens."
            }
          />
        ) : null}

        {entries.data && entries.data.items.length > 0 ? (
          <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
            {entries.data.items.map((entry) => (
              <EntryRow key={entry.id} entry={entry} areaName={areaName(entry.areaId)} />
            ))}
          </ul>
        ) : null}

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
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
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

/**
 * One recorded fact. The detail blob is folded away rather than dropped: it is
 * where the abort stage, the file count and the old and new criticality live,
 * and its shape differs per action — which is exactly why it is shown as what
 * it is instead of being flattened into columns that would fit none of them.
 */
function EntryRow({ entry, areaName }: { entry: AuditEntry; areaName: string | null }) {
  const [open, setOpen] = useState(false);
  const action = ACTIONS[entry.action];
  const detail = Object.entries(entry.detail);
  const at = new Date(entry.at);

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <div className="w-32 shrink-0">
          <p className="font-mono text-[11px] text-ink">
            {at.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </p>
          <p className="font-mono text-[10px] text-ink-faint">
            {at.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* A failure is marked, a success is not. Most of the log is
                successes, and colouring all of them would say nothing. */}
            {entry.outcome === "failure" ? (
              <span className="rounded-[var(--radius-control)] bg-modifies-quiet px-1.5 py-0.5 text-[10px] font-semibold text-modifies">
                Failed
              </span>
            ) : null}
            <span className="text-[12px] font-medium text-ink">{action.label}</span>
            {entry.subject ? (
              <span className="truncate font-mono text-[11px] text-ink-muted">{entry.subject}</span>
            ) : null}
          </div>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-ink-faint">
            <span className="font-mono text-ink-muted">{entry.actor}</span>
            {areaName ? <span>· {areaName}</span> : null}
            {entry.sourceIp ? <span>· {entry.sourceIp}</span> : null}
            {entry.runId ? (
              <Link
                href={`/runs/${entry.runId}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                · open the run
              </Link>
            ) : null}
            {detail.length > 0 ? (
              <button
                type="button"
                onClick={() => setOpen(!open)}
                className="text-ink-muted underline-offset-2 hover:text-ink hover:underline"
              >
                · {open ? "hide detail" : "detail"}
              </button>
            ) : null}
          </p>

          {open && detail.length > 0 ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-[var(--radius-control)] bg-surface-sunken px-3 py-2">
              {detail.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="font-mono text-[10px] text-ink-faint">{key}</dt>
                  <dd className="break-all font-mono text-[10px] text-ink-muted">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      {children}
    </label>
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

function Centered({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-[var(--radius-panel)] border border-line bg-surface px-5 py-4">
        <p className="text-[13px] font-medium text-ink">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{detail}</p>
      </div>
    </div>
  );
}
