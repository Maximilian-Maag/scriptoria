import { scriptHeaderSchema, type Script, type ScriptHeader } from "@scriptoria/contracts";
import { canAccessArea } from "@scriptoria/core";
import { areaRepository, scriptRepository, type ScannedScript } from "@scriptoria/db";
import { loadBackendConfig } from "@scriptoria/config";
import type { Session } from "../auth/session";
import { scanScripts } from "../runner/client";
import { forbidden, ok, type Result } from "../result";

/**
 * FA-03.3/3.4/3.5 — the scripts of one area, with the header each one declares
 * about itself.
 *
 * The script VM's filesystem is the truth and this is a cache of it (ADR-004).
 * The cache is short-lived on purpose: a script owner who corrects a header
 * expects to see the correction, and listing a directory over an SSH connection
 * the runner opens anyway is cheap.
 *
 * What is never cached is the authorisation. The area check happens on every
 * call, against the session, before anything is read.
 */
export async function listScripts(session: Session, areaId: string): Promise<Result<Script[]>> {
  if (!canAccessArea(session.areaIds, areaId)) {
    // Deliberately `forbidden` rather than `not_found`: the area id came from
    // this user's own navigation, so there is nothing to conceal, and an
    // honest 403 is easier to support than a puzzling 404.
    return forbidden();
  }

  if (await isStale(areaId)) await rescan(areaId);
  return ok(await scriptRepository.listScriptsForArea(areaId));
}

/**
 * Forces a rescan regardless of the cache — what the catalog's refresh control
 * calls, for the script owner who has just put a new file on the VM and wants
 * to see it now.
 */
export async function refresh(session: Session, areaId: string): Promise<Result<Script[]>> {
  if (!canAccessArea(session.areaIds, areaId)) return forbidden();
  await rescan(areaId);
  return ok(await scriptRepository.listScriptsForArea(areaId));
}

async function isStale(areaId: string): Promise<boolean> {
  const scannedAt = await scriptRepository.lastScannedAt(areaId);
  if (!scannedAt) return true;
  const ttl = loadBackendConfig().CATALOG_CACHE_TTL_SECONDS * 1000;
  return Date.now() - scannedAt.getTime() > ttl;
}

/**
 * Asks the runner to read every mapped directory of this area.
 *
 * A source that cannot be reached leaves its own scripts as they were rather
 * than emptying the catalog. One script VM being down is a reason to show a
 * stale list, not a reason to tell an administrator that their area is empty —
 * which is what FA-01.4's empty state means, and it would be a lie here.
 */
async function rescan(areaId: string): Promise<void> {
  const sources = await areaRepository.listSourcesForAreas([areaId]);

  for (const source of sources) {
    const scan = await scanScripts(
      { host: source.host, port: source.port, username: source.username },
      source.scriptPath,
    );
    if (!scan.ok) {
      console.error("catalog scan failed", {
        areaId,
        host: source.host,
        path: source.scriptPath,
        code: scan.code,
        message: scan.message,
      });
      continue;
    }

    const scanned: ScannedScript[] = scan.value.scripts.map((script) => ({
      fileName: script.fileName,
      absolutePath: script.absolutePath,
      header: parseHeader(script.header),
      sizeBytes: script.sizeBytes,
      modifiedAt: script.modifiedAt ? new Date(script.modifiedAt) : null,
    }));

    await scriptRepository.replaceSourceScripts(areaId, source.id, scanned);
  }
}

/**
 * The runner parsed the block; this validates it before it is stored, because
 * what goes into a JSONB column is what comes back out of it, and a header that
 * arrived malformed should stop here rather than at the renderer.
 */
function parseHeader(header: unknown): ScriptHeader | null {
  if (header === null || header === undefined) return null;
  const parsed = scriptHeaderSchema.safeParse(header);
  return parsed.success ? parsed.data : null;
}
