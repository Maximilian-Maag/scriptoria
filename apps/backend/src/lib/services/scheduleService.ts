import type { Schedule, UpdateScheduleRequest } from "@scriptoria/contracts";
import {
  managedJobs,
  nextRunAt,
  parseCrontab,
  scheduleId,
  validateCronExpression,
  writeManagedBlock,
  type CrontabLine,
  type ManagedEntry,
} from "@scriptoria/core";
import {
  areaRepository,
  auditRepository as audit,
  runRepository,
  scriptRepository,
} from "@scriptoria/db";
import type { Session } from "../auth/session";
import { readCrontab, writeCrontab } from "../runner/client";
import { conflict, notFound, ok, type Result } from "../result";

/**
 * FA-10 / ADR-005 — recurring scripts, where the crontab is the truth and this
 * service is a guest in it.
 *
 * There is no scheduler here and there must never be one. Two schedulers is two
 * truths, and the failure mode is jobs that run twice or never — in an estate
 * where a double run means hundreds of sites getting the same change applied
 * again. Whatever already monitors the crontab hangs off the first one (NFR-16).
 *
 * Everything derivable from the crontab is derived on every read rather than
 * cached: *next run* from the expression, the human phrasing from the
 * expression, the identity of a line from its command. So a schedule somebody
 * edits over SSH is picked up here automatically instead of quietly disagreeing
 * with a copy this platform kept.
 *
 * The only thing this service writes is the block between the two delimiters.
 * Everything outside it comes back byte-for-byte, and that property lives in
 * `@scriptoria/core`'s pure functions where tests pin it down.
 */

/** What a crontab read produced, plus the context needed to write it back. */
interface AreaCrontab {
  areaId: string;
  sourceId: string;
  target: { host: string; port: number; username: string };
  text: string;
  lines: CrontabLine[];
}

/**
 * FA-10.1 — every recurring script the session may see.
 *
 * One crontab per mapped script VM, read live. A source whose VM cannot be
 * reached is skipped rather than failing the page: one unreachable host must
 * not hide the schedules of every other area (NFR-07 allows several).
 */
export async function listSchedules(
  session: Session,
  filter: { areaId?: string } = {},
): Promise<Result<Schedule[]>> {
  const scope = await scopeFor(session);
  const areaIds = filter.areaId ? scope.filter((id) => id === filter.areaId) : scope;
  if (areaIds.length === 0) return ok([]);

  const crontabs = await readAreaCrontabs(areaIds);

  // The catalog is what turns a crontab command into a script somebody can run
  // from the interface (FA-10.3). A command pointing outside the mapped script
  // directory stays listed with a null scriptId — it is somebody's job and the
  // overview would be lying if it hid it.
  const scriptsByArea = new Map(
    await Promise.all(
      areaIds.map(
        async (areaId) => [areaId, await scriptRepository.listScriptsForArea(areaId)] as const,
      ),
    ),
  );

  const schedules: Schedule[] = [];
  for (const crontab of crontabs) {
    const scripts = scriptsByArea.get(crontab.areaId) ?? [];
    // The same command can legitimately appear twice — once by hand and once in
    // the managed block, at different times. Counting occurrences in file order
    // is what keeps those two distinct schedules rather than one.
    const seen = new Map<string, number>();

    for (const line of crontab.lines) {
      if (line.kind !== "job") continue;

      const occurrence = seen.get(line.command) ?? 0;
      seen.set(line.command, occurrence + 1);

      const script = scripts.find((candidate) => line.command.includes(candidate.absolutePath));
      const validation = validateCronExpression(line.expression);

      schedules.push({
        id: scheduleId(crontab.sourceId, line.command, occurrence),
        areaId: crontab.areaId,
        sourceId: crontab.sourceId,
        scriptId: script?.id ?? null,
        command: line.command,
        expression: line.expression,
        expressionDescription: validation.description || line.expression,
        managed: line.managed,
        enabled: line.enabled,
        lastSuccessfulAt: null,
        lastRunAt: null,
        // A disabled line has no next run, and saying otherwise would be the
        // interface contradicting the checkbox next to it.
        nextRunAt: line.enabled ? (nextRunAt(line.expression)?.toISOString() ?? null) : null,
      });
    }
  }

  // FA-10.2, filled in one query rather than one per line.
  const scriptIds = schedules.map((s) => s.scriptId).filter((id): id is string => id !== null);
  const lastSuccessful = await runRepository.lastSuccessfulByScript(scriptIds);

  return ok(
    schedules.map((schedule) => ({
      ...schedule,
      lastSuccessfulAt: schedule.scriptId
        ? (lastSuccessful.get(schedule.scriptId)?.toISOString() ?? null)
        : null,
    })),
  );
}

/**
 * FA-10.4 — the root account changes a schedule without shell access.
 *
 * Only lines inside the managed block are editable. A hand-written line is
 * shown but refused here, and that refusal is ADR-005 being kept rather than a
 * missing feature: the platform edits what it wrote and leaves the rest alone.
 * Somebody's `30 4 * * 1 find … -delete` is not the platform's to reformat.
 *
 * The command is never editable, only the expression and the enabled flag. An
 * editable command would make this a remote shell with a cron face on it.
 */
export async function updateSchedule(
  session: Session,
  id: string,
  request: UpdateScheduleRequest,
  context: { sourceIp?: string | null } = {},
): Promise<Result<Schedule>> {
  if (request.expression !== undefined) {
    const validation = validateCronExpression(request.expression);
    if (!validation.valid) {
      return conflict(`That is not a schedule cron understands: ${validation.error ?? "invalid"}`);
    }
  }

  const crontabs = await readAreaCrontabs(await scopeFor(session));

  for (const crontab of crontabs) {
    // Ordinals have to be counted over *every* job line, exactly as the read
    // path counts them — a managed line's occurrence number includes the
    // hand-written lines above it carrying the same command. Counting only
    // within the managed block would make the two paths disagree and the edit
    // land on a different line than the one the interface showed.
    const ids = occurrenceIds(crontab);
    const entries = managedJobs(crontab.lines);

    const managedIds = crontab.lines
      .map((line, position) => ({ line, id: ids[position] }))
      .filter((entry) => entry.line.kind === "job" && entry.line.managed)
      .map((entry) => entry.id);

    const index = managedIds.indexOf(id);
    if (index === -1) continue;

    const current = entries[index] as ManagedEntry;
    const updated: ManagedEntry = {
      command: current.command,
      expression: request.expression ?? current.expression,
      enabled: request.enabled ?? current.enabled,
    };
    const next = [...entries];
    next[index] = updated;

    // Read-modify-write against the text that was just read. The window between
    // the two is small but real; cron's own `crontab -` is all-or-nothing, so a
    // concurrent edit loses rather than corrupts.
    const written = await writeCrontab(crontab.target, writeManagedBlock(crontab.text, next));
    if (!written.ok) return written;

    await audit.record({
      actor: session.username,
      action: "schedule_updated",
      subject: current.command,
      areaId: crontab.areaId,
      detail: {
        host: crontab.target.host,
        before: { expression: current.expression, enabled: current.enabled },
        after: { expression: updated.expression, enabled: updated.enabled },
      },
      sourceIp: context.sourceIp ?? null,
    });

    const fresh = await listSchedules(session, { areaId: crontab.areaId });
    if (!fresh.ok) return fresh;
    const found = fresh.value.find((schedule) => schedule.id === id);
    return found ? ok(found) : notFound("The schedule is gone from the crontab");
  }

  // Either it never existed, or it is a hand-written line. The two are worth
  // telling apart: one is a mistake, the other is the platform behaving.
  const anyLine = crontabs
    .flatMap((crontab) => occurrenceIds(crontab).filter((value): value is string => value !== null))
    .includes(id);

  return anyLine
    ? conflict(
        "That line was written by hand on the script VM, so the platform does not edit it. " +
          "Change it there, or move it into the managed block.",
      )
    : notFound("No such schedule");
}

/**
 * The schedule id of every line of a crontab, positionally — null for lines that
 * are not jobs, so an index into this array is an index into `crontab.lines`.
 *
 * One function, used by both the read and the write path, because the ordinals
 * they compute have to agree. Two implementations of "the nth line with this
 * command" is two chances to disagree about which line an edit lands on.
 */
function occurrenceIds(crontab: AreaCrontab): (string | null)[] {
  const seen = new Map<string, number>();
  return crontab.lines.map((line) => {
    if (line.kind !== "job") return null;
    const occurrence = seen.get(line.command) ?? 0;
    seen.set(line.command, occurrence + 1);
    return scheduleId(crontab.sourceId, line.command, occurrence);
  });
}

/**
 * Which areas this session's schedule views cover.
 *
 * The same asymmetry the area administration has, for the same reason: an
 * administrator sees what their groups reach, and the root account — which FA-11
 * makes responsible for maintaining recurring jobs — is entitled to no areas at
 * all. Scoping root by its own entitlements would show it nothing, and the one
 * account charged with fixing a schedule would be the one account that cannot
 * see it.
 */
async function scopeFor(session: Session): Promise<string[]> {
  return session.role === "root" ? areaRepository.listAllAreaIds() : [...session.areaIds];
}

/** Reads one crontab per mapped script VM, skipping the ones that will not answer. */
async function readAreaCrontabs(areaIds: readonly string[]): Promise<AreaCrontab[]> {
  if (areaIds.length === 0) return [];
  const sources = await areaRepository.listSourcesForAreas(areaIds);

  const crontabs = await Promise.all(
    sources.map(async (source) => {
      const target = { host: source.host, port: source.port, username: source.username };
      const read = await readCrontab(target);
      if (!read.ok) {
        // NFR-07 allows several script VMs per estate. One being down is a
        // reason to show fewer schedules, not to show none.
        console.error("could not read a crontab", {
          host: source.host,
          areaId: source.areaId,
          message: read.message,
        });
        return null;
      }
      const text = read.value ?? "";
      return {
        areaId: source.areaId,
        sourceId: source.id,
        target,
        text,
        lines: parseCrontab(text),
      } satisfies AreaCrontab;
    }),
  );

  return crontabs.filter((crontab): crontab is AreaCrontab => crontab !== null);
}
