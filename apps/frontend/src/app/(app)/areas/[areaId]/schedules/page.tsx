"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Schedule } from "@scriptoria/contracts";
import { ApiFailure, api } from "@/lib/api";
import { AreaTabs } from "@/components/AreaTabs";
import { useSession } from "@/lib/session";

/**
 * FA-10 — which scripts run regularly, and when.
 *
 * Read live off the script VM's crontab on every load. ADR-005 makes that file
 * the single source of truth and the platform a guest in it, so there is no
 * cached copy here to disagree with it: a schedule somebody changed over SSH
 * simply appears.
 *
 * The screen is honest about two things that a prettier one would hide.
 *
 * **Lines the platform did not write are shown but not editable.** They are
 * somebody's jobs, they predate this product, and ADR-005 promises they survive
 * every write byte-for-byte. Hiding them would make the overview a lie —
 * FA-10.1 asks which scripts run regularly, not which ones this platform
 * happens to manage.
 *
 * **Last successful covers only platform-started runs.** The platform does not
 * see a cron-started run happen, only what it left behind, and FA-10.2 was
 * reduced to *last successful* for exactly that reason. Rebuilding failure
 * alerting here would be a second, worse copy of the monitoring that already
 * watches the crontab (NFR-16).
 */
export default function AreaSchedulesPage({ params }: { params: Promise<{ areaId: string }> }) {
  const { areaId } = use(params);
  const session = useSession();
  const isRoot = session.data?.user?.role === "root";

  const schedules = useQuery({
    queryKey: ["schedules", areaId],
    queryFn: () => api.schedules(areaId),
  });

  const managed = schedules.data?.filter((schedule) => schedule.managed) ?? [];
  const foreign = schedules.data?.filter((schedule) => !schedule.managed) ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-line px-6 py-4">
        <AreaTabs areaId={areaId} />
        <p className="mt-3 text-[11px] text-ink-faint">
          {schedules.isLoading
            ? "Reading the crontab…"
            : `${schedules.data?.length ?? 0} in the crontab on this area's script VM`}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {schedules.isError ? (
          <Notice
            title="Could not read the crontab"
            detail={
              schedules.error instanceof ApiFailure
                ? schedules.error.message
                : "The script VM did not answer."
            }
          />
        ) : null}

        {schedules.data?.length === 0 ? (
          <Notice
            title="Nothing runs on a schedule here"
            detail="The crontab on this area's script VM has no jobs in it. Schedules are maintained there and read from there — this platform runs no scheduler of its own."
          />
        ) : null}

        {managed.length > 0 ? (
          <Section
            title="Maintained here"
            note="Edited through this screen and written back into the crontab."
          >
            {managed.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                schedule={schedule}
                areaId={areaId}
                editable={isRoot}
              />
            ))}
          </Section>
        ) : null}

        {foreign.length > 0 ? (
          <Section
            title="Written by hand on the script VM"
            note="Shown because they run here too. The platform leaves them exactly as they are."
          >
            {foreign.map((schedule) => (
              <ScheduleRow key={schedule.id} schedule={schedule} areaId={areaId} editable={false} />
            ))}
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function ScheduleRow({
  schedule,
  areaId,
  editable,
}: {
  schedule: Schedule;
  areaId: string;
  editable: boolean;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [expression, setExpression] = useState(schedule.expression);
  const [error, setError] = useState<string | null>(null);

  const refresh = (fresh: Schedule) => {
    client.setQueryData<Schedule[]>(["schedules", areaId], (current) =>
      current?.map((item) => (item.id === fresh.id ? fresh : item)),
    );
    void client.invalidateQueries({ queryKey: ["schedules", areaId] });
  };

  const save = useMutation({
    mutationFn: (request: { expression?: string; enabled?: boolean }) =>
      api.updateSchedule(schedule.id, request),
    onSuccess: (fresh) => {
      setEditing(false);
      setError(null);
      refresh(fresh);
    },
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not change the schedule"),
  });

  /** FA-10.3 — the same script, started now, to get its result immediately. */
  const runNow = useMutation({
    mutationFn: () =>
      api.startRun({
        scriptId: schedule.scriptId as string,
        cols: Math.max(20, Math.min(500, Math.floor((window.innerWidth - 420) / 8))),
        rows: 30,
      }),
    onSuccess: (run) => router.push(`/runs/${run.id}`),
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not start it"),
  });

  return (
    <li
      className={`rounded-[var(--radius-panel)] border bg-surface px-4 py-3 ${
        schedule.enabled ? "border-line" : "border-dashed border-line"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-[var(--radius-control)] bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink">
              {schedule.expression}
            </span>
            <span className="text-[13px] text-ink">{schedule.expressionDescription}</span>
            {!schedule.enabled ? (
              <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                Disabled
              </span>
            ) : null}
          </div>

          <p
            className="mt-1 truncate font-mono text-[11px] text-ink-faint"
            title={schedule.command}
          >
            {schedule.command}
          </p>

          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[10px]">
            <Fact label="Next">{schedule.enabled ? when(schedule.nextRunAt) : "—"}</Fact>
            <Fact label="Last successful">
              {/* FA-10.2 / O-1. Only runs this platform started are visible to
                  it, and a schedule cron has been running for months can show
                  nothing here. Saying so beats an empty cell. */}
              {schedule.scriptId ? when(schedule.lastSuccessfulAt) : "not a script in this area"}
            </Fact>
          </dl>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {schedule.scriptId ? (
            <button
              type="button"
              onClick={() => runNow.mutate()}
              disabled={runNow.isPending}
              className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 text-[11px] text-ink-muted hover:bg-surface-sunken disabled:opacity-50"
            >
              {runNow.isPending ? "Starting…" : "Run now"}
            </button>
          ) : null}

          {editable ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setExpression(schedule.expression);
                  setEditing((open) => !open);
                  setError(null);
                }}
                className="text-[11px] text-ink-faint underline-offset-2 hover:text-ink hover:underline"
              >
                {editing ? "Cancel" : "Change"}
              </button>
              <button
                type="button"
                onClick={() => save.mutate({ enabled: !schedule.enabled })}
                disabled={save.isPending}
                className="text-[11px] text-ink-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
              >
                {schedule.enabled ? "Disable" : "Enable"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {editing ? (
        <form
          className="mt-3 flex items-end gap-2 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate({ expression: expression.trim() });
          }}
        >
          <label className="flex-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Cron expression
            </span>
            <input
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              spellCheck={false}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink"
            />
            <span className="mt-1 block text-[10px] text-ink-faint">
              Five fields: minute hour day-of-month month day-of-week. The command is not editable
              here — only when it runs.
            </span>
          </label>
          <button
            type="submit"
            disabled={save.isPending || expression.trim() === schedule.expression}
            className="rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-50"
          >
            {save.isPending ? "Writing…" : "Save"}
          </button>
        </form>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-[var(--radius-control)] bg-modifies-quiet px-3 py-2 text-[11px] leading-relaxed text-modifies"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{title}</h2>
      <p className="mt-0.5 mb-2 text-[11px] text-ink-muted">{note}</p>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="text-ink-muted">{children}</dd>
    </div>
  );
}

function when(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-3 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{detail}</p>
    </div>
  );
}
