"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Area, AreaCategory } from "@scriptoria/contracts";
import { ApiFailure, api } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * FA-11 — the root account's screen, and the only one in the product where
 * areas are written rather than read.
 *
 * This is where the platform stops being functionless. An area is a directory
 * of scripts on a script VM plus the directory groups entitled to it, and until
 * both halves exist every administrator signs in successfully and sees nothing.
 * The screen is laid out in that order for that reason: the area, then the paths
 * its scripts come from, then the groups that may reach them.
 *
 * Nothing here synchronises a group. A group is named, and the name is matched
 * against what the directory reports at each login (NFR-04) — so the field below
 * is a free-text box on purpose, and a name that matches nothing yet is a valid
 * thing to save.
 */

const CATEGORY_LABEL: Record<AreaCategory, string> = {
  "one-off": "One-off scripts",
  recurring: "Recurring scripts",
};

export default function AdminAreasPage() {
  const session = useSession();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const isRoot = session.data?.user?.role === "root";

  const areas = useQuery({
    queryKey: ["admin", "areas"],
    queryFn: () => api.admin.areas(),
    enabled: isRoot,
  });

  /**
   * Every mutation on this screen can change what the left navigation should
   * show — including for the root account's own session, which the control
   * plane re-entitles in the same request (NFR-03). Refetching both is how the
   * interface stays honest about that rather than showing a stale menu.
   */
  const refresh = (fresh?: Area) => {
    if (fresh)
      client.setQueryData<Area[]>(["admin", "areas"], (current) =>
        current?.map((area) => (area.id === fresh.id ? fresh : area)),
      );
    void client.invalidateQueries({ queryKey: ["admin", "areas"] });
    void client.invalidateQueries({ queryKey: ["areas"] });
  };

  if (session.isLoading) return null;

  if (!isRoot) {
    return (
      <Centered
        title="Administration is the root account's"
        detail="Your account is signed in and entitled to its areas, but changing what the areas are is a different job and a different account. Root is not a bigger administrator — it configures what administrators can reach."
      />
    );
  }

  const selected = areas.data?.find((area) => area.id === selectedId) ?? null;

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <h1 className="text-sm font-semibold text-ink">Areas</h1>
            <p className="text-[11px] text-ink-faint">
              {areas.data ? `${areas.data.length} configured` : "Loading…"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
            className="rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-[11px] font-medium text-ink-inverse hover:bg-accent-hover"
          >
            New area
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {areas.isError ? (
            <Notice
              title="Could not load the areas"
              detail={
                areas.error instanceof ApiFailure
                  ? areas.error.message
                  : "The control plane did not answer."
              }
            />
          ) : null}

          {areas.data?.length === 0 && !creating ? (
            <Notice
              title="No areas yet"
              detail="Until an area exists and a directory group is entitled to it, every administrator signs in successfully and sees an empty screen. Creating the first one is what turns the platform on."
            />
          ) : null}

          <ul className="space-y-2">
            {areas.data?.map((area) => (
              <li key={area.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(area.id);
                    setCreating(false);
                  }}
                  className={`w-full rounded-[var(--radius-panel)] border px-4 py-3 text-left ${
                    area.id === selectedId
                      ? "border-accent bg-accent-quiet/40"
                      : "border-line bg-surface hover:border-line-strong"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink">{area.name}</p>
                      <p className="truncate text-[11px] text-ink-faint">
                        {CATEGORY_LABEL[area.category]}
                      </p>
                    </div>
                    <Counts area={area} />
                  </div>
                  {area.description ? (
                    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                      {area.description}
                    </p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {creating ? (
        <CreateAreaPanel
          onCancel={() => setCreating(false)}
          onCreated={(area) => {
            setCreating(false);
            setSelectedId(area.id);
            refresh();
          }}
        />
      ) : selected ? (
        <AreaDetailPanel
          /* Remounts on selection, so the forms below start from the area on
             screen rather than holding the previous one's half-typed values. */
          key={selected.id}
          area={selected}
          onChanged={refresh}
          onDeleted={() => {
            setSelectedId(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The two numbers that say whether an area is finished. An area with no paths
 * shows no scripts; an area with no groups is invisible to everyone. Both are
 * survivable half-states, and both are worth seeing from the list.
 */
function Counts({ area }: { area: Area }) {
  const incomplete = area.sources.length === 0 || area.entitlements.length === 0;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        incomplete ? "bg-undeclared-quiet text-undeclared" : "bg-surface-sunken text-ink-muted"
      }`}
    >
      {area.sources.length} {area.sources.length === 1 ? "path" : "paths"} ·{" "}
      {area.entitlements.length} {area.entitlements.length === 1 ? "group" : "groups"}
    </span>
  );
}

function CreateAreaPanel({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (area: Area) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<AreaCategory>("one-off");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.admin.createArea({ name, description, category }),
    onSuccess: onCreated,
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not create the area"),
  });

  return (
    <Panel title="New area" subtitle="FA-11.1">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          hint="Simplest arrangement: the same name as the directory group entitled to it."
          required
        />
        <TextArea label="Description" value={description} onChange={setDescription} />
        <CategoryField value={category} onChange={setCategory} />

        {error ? <ErrorText>{error}</ErrorText> : null}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={create.isPending || name.trim() === ""}
            className="flex-1 rounded-[var(--radius-control)] bg-accent px-3 py-2 text-[13px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-60"
          >
            {create.isPending ? "Creating…" : "Create area"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink-muted hover:bg-surface-sunken"
          >
            Cancel
          </button>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-faint">
          A new area is reachable by nobody until a directory group is entitled to it, and shows
          nothing until a path is mapped onto it.
        </p>
      </form>
    </Panel>
  );
}

function AreaDetailPanel({
  area,
  onChanged,
  onDeleted,
}: {
  area: Area;
  onChanged: (fresh?: Area) => void;
  onDeleted: () => void;
}) {
  return (
    <aside className="flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">{area.name}</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">{CATEGORY_LABEL[area.category]}</p>
      </div>

      <div className="space-y-7 px-5 py-5">
        <AreaSettings area={area} onChanged={onChanged} />
        <SourceSection area={area} onChanged={onChanged} />
        <EntitlementSection area={area} onChanged={onChanged} />
        <DangerSection area={area} onDeleted={onDeleted} />
      </div>
    </aside>
  );
}

function AreaSettings({ area, onChanged }: { area: Area; onChanged: (fresh?: Area) => void }) {
  const [name, setName] = useState(area.name);
  const [description, setDescription] = useState(area.description);
  const [category, setCategory] = useState<AreaCategory>(area.category);
  const [error, setError] = useState<string | null>(null);

  // The panel is keyed on the area id, so these initial values are always the
  // selected area's rather than a stale copy of the one selected before it.
  const dirty =
    name !== area.name || description !== area.description || category !== area.category;

  const save = useMutation({
    mutationFn: () => api.admin.updateArea(area.id, { name, description, category }),
    onSuccess: (fresh) => {
      setError(null);
      onChanged(fresh);
    },
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not save the area"),
  });

  return (
    <Section title="Area" note="FA-11.1 · FA-11.5">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} required />
        <TextArea label="Description" value={description} onChange={setDescription} />
        <CategoryField value={category} onChange={setCategory} />

        {error ? <ErrorText>{error}</ErrorText> : null}

        <button
          type="submit"
          disabled={!dirty || save.isPending || name.trim() === ""}
          className="w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
      </form>
    </Section>
  );
}

/** FA-11.2 — the filesystem paths whose scripts belong to this area. */
function SourceSection({ area, onChanged }: { area: Area; onChanged: (fresh?: Area) => void }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOpen(false);
    setHost("");
    setPort("22");
    setUsername("");
    setScriptPath("");
    setOutputPath("");
    setError(null);
  };

  const add = useMutation({
    mutationFn: () =>
      api.admin.addSource(area.id, {
        host,
        port: Number(port),
        username,
        scriptPath,
        outputPath,
      }),
    onSuccess: (fresh) => {
      reset();
      onChanged(fresh);
    },
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not map the path"),
  });

  const remove = useMutation({
    mutationFn: (sourceId: string) => api.admin.removeSource(area.id, sourceId),
    onSuccess: (fresh) => onChanged(fresh),
  });

  return (
    <Section title="Script paths" note="FA-11.2">
      {area.sources.length === 0 ? (
        <Empty>
          No path is mapped, so this area shows no scripts. That is a configuration gap rather than
          an empty directory.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {area.sources.map((source) => (
            <li
              key={source.id}
              className="rounded-[var(--radius-control)] border border-line px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px] text-ink">{source.scriptPath}</p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                    {source.username}@{source.host}
                    {source.port === 22 ? "" : `:${source.port}`}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                    results → {source.outputPath}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => remove.mutate(source.id)}
                  disabled={remove.isPending}
                  className="shrink-0 text-[11px] text-ink-faint underline-offset-2 hover:text-modifies hover:underline disabled:opacity-50"
                >
                  Unmap
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <form
          className="mt-3 space-y-3 rounded-[var(--radius-control)] bg-surface-sunken p-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            add.mutate();
          }}
        >
          <TextField label="Script VM host" value={host} onChange={setHost} required />
          <div className="flex gap-2">
            <div className="w-20">
              <TextField label="Port" value={port} onChange={setPort} />
            </div>
            <div className="flex-1">
              <TextField
                label="Runs as"
                value={username}
                onChange={setUsername}
                hint="The account on the script VM (FA-05.3)."
                required
              />
            </div>
          </div>
          <TextField
            label="Script directory"
            value={scriptPath}
            onChange={setScriptPath}
            mono
            required
          />
          <TextField
            label="Output directory"
            value={outputPath}
            onChange={setOutputPath}
            mono
            hint="Where the scripts write their results, and the only place they are collected from."
            required
          />

          {error ? <ErrorText>{error}</ErrorText> : null}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={add.isPending}
              className="flex-1 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-[12px] font-medium text-ink-inverse hover:bg-accent-hover disabled:opacity-60"
            >
              {add.isPending ? "Mapping…" : "Map this path"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[12px] text-ink-muted hover:bg-surface"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <AddButton onClick={() => setOpen(true)}>Map a path</AddButton>
      )}
    </Section>
  );
}

/** FA-11.3, FA-11.4 — the directory groups entitled to this area. */
function EntitlementSection({
  area,
  onChanged,
}: {
  area: Area;
  onChanged: (fresh?: Area) => void;
}) {
  const [group, setGroup] = useState("");
  const [error, setError] = useState<string | null>(null);

  const grant = useMutation({
    mutationFn: () => api.admin.grantEntitlement(area.id, { directoryGroup: group.trim() }),
    onSuccess: (fresh) => {
      setGroup("");
      setError(null);
      onChanged(fresh);
    },
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not entitle the group"),
  });

  const revoke = useMutation({
    mutationFn: (entitlementId: string) => api.admin.revokeEntitlement(area.id, entitlementId),
    onSuccess: (fresh) => onChanged(fresh),
  });

  return (
    <Section title="Entitled groups" note="FA-11.3 · FA-11.4">
      {area.entitlements.length === 0 ? (
        <Empty>
          No group is entitled, so nobody can see this area. An administrator in no entitled group
          signs in perfectly well and lands on an empty screen.
        </Empty>
      ) : (
        <ul className="space-y-1.5">
          {area.entitlements.map((entitlement) => (
            <li
              key={entitlement.id}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5"
            >
              <span className="truncate font-mono text-[11px] text-ink">
                {entitlement.directoryGroup}
              </span>
              <button
                type="button"
                onClick={() => revoke.mutate(entitlement.id)}
                disabled={revoke.isPending}
                className="shrink-0 text-[11px] text-ink-faint underline-offset-2 hover:text-modifies hover:underline disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          if (group.trim() !== "") grant.mutate();
        }}
      >
        <TextField
          label="Directory group"
          value={group}
          onChange={setGroup}
          mono
          hint="Referenced by name, never copied. Membership is read from the directory at every login."
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <button
          type="submit"
          disabled={grant.isPending || group.trim() === ""}
          className="w-full rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
        >
          {grant.isPending ? "Entitling…" : "Entitle this group"}
        </button>
      </form>

      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        Revoking takes effect immediately — anyone signed in through this group loses the area
        without being signed out.
      </p>
    </Section>
  );
}

function DangerSection({ area, onDeleted }: { area: Area; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => api.admin.deleteArea(area.id),
    onSuccess: onDeleted,
    onError: (cause) =>
      setError(cause instanceof ApiFailure ? cause.message : "Could not delete the area"),
  });

  return (
    <Section title="Delete" note="">
      {error ? <ErrorText>{error}</ErrorText> : null}

      {confirming ? (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-ink-muted">
            This removes “{area.name}”, its path mappings and its group entitlements. An area that
            anything has ever been run in cannot be deleted at all — the run history outranks
            tidying up.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="flex-1 rounded-[var(--radius-control)] bg-modifies px-3 py-1.5 text-[12px] font-medium text-ink-inverse disabled:opacity-60"
            >
              {remove.isPending ? "Deleting…" : "Delete this area"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[12px] text-ink-muted hover:bg-surface-sunken"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="text-[11px] text-ink-faint underline-offset-2 hover:text-modifies hover:underline"
        >
          Delete this area
        </button>
      )}
    </Section>
  );
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <aside className="flex w-[26rem] shrink-0 flex-col overflow-y-auto border-l border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">{subtitle}</p>
      </div>
      <div className="px-5 py-5">{children}</div>
    </aside>
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
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          {title}
        </h3>
        {note ? <span className="text-[10px] text-ink-faint">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  mono,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  mono?: boolean;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <input
        type="text"
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink ${
          mono ? "font-mono" : ""
        }`}
      />
      {hint ? (
        <span className="mt-1 block text-[10px] leading-relaxed text-ink-faint">{hint}</span>
      ) : null}
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <textarea
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full resize-y rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1.5 text-[12px] leading-relaxed text-ink"
      />
    </label>
  );
}

/** FA-11.5 — the category structures the navigation and nothing else. */
function CategoryField({
  value,
  onChange,
}: {
  value: AreaCategory;
  onChange: (value: AreaCategory) => void;
}) {
  return (
    <div>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        Category
      </span>
      <div className="mt-1 flex gap-2">
        {(Object.keys(CATEGORY_LABEL) as AreaCategory[]).map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => onChange(category)}
            className={`flex-1 rounded-[var(--radius-control)] border px-2 py-1.5 text-[11px] ${
              value === category
                ? "border-accent bg-accent-quiet font-medium text-accent"
                : "border-line text-ink-muted hover:bg-surface-sunken"
            }`}
          >
            {CATEGORY_LABEL[category]}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 w-full rounded-[var(--radius-control)] border border-dashed border-line-strong px-3 py-1.5 text-[12px] text-ink-muted hover:bg-surface-sunken"
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--radius-control)] bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
      {children}
    </p>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-control)] bg-modifies-quiet px-3 py-2 text-[11px] leading-relaxed text-modifies"
    >
      {children}
    </p>
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
      <div className="max-w-md text-center">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{detail}</p>
      </div>
    </div>
  );
}
