import type Redis from "ioredis";
import {
  RPC_FRAME,
  rpcRequestSchema,
  type ListFilesResult,
  type ReadFileHeader,
  type RpcError,
  type RpcRequest,
  type ScanResult,
  type SshTarget,
} from "@scriptoria/contracts";
import { parseScriptHeader } from "@scriptoria/core";
import { connectTo } from "../driver/sshTarget";
import type { ExecutionTarget } from "../driver/executionTarget";
import { blockingConnection, keys, redis } from "../redis";
import { describeError, log } from "../log";

/**
 * The two things the control plane cannot do for itself: look at the script
 * directory, and read a result file.
 *
 * Both are reads of the script VM's filesystem, and ADR-001 keeps the SSH key
 * material in exactly one container — so they are asked for here instead. A
 * control plane that could read the script directory could also run what is in
 * it, and the boundary is drawn where the credentials are.
 *
 * The transport is a Redis list per request rather than an HTTP call, because
 * the runner listens on no port. That is not an inconvenience to work around:
 * it is the property that makes the runner unreachable from everywhere except
 * the queue.
 */

/**
 * How many requests are served at once. Separate from `RUNNER_CONCURRENCY`,
 * which counts PTYs: a catalog listing must not have to wait behind somebody
 * downloading a 300 MB result set.
 */
const RPC_SLOTS = 4;

const POP_TIMEOUT_SECONDS = 5;

/** A reply nobody drains is rubbish after a minute. */
const REPLY_TTL_SECONDS = 120;

/** Enough for ADR-004's first 100 lines, and nothing like enough for a body. */
const HEADER_READ_BYTES = 64 * 1024;

/** Chunk size for a streamed file. One Redis list entry each. */
const READ_CHUNK_BYTES = 256 * 1024;

export class RpcServer {
  private readonly connection: Redis = blockingConnection();
  private running = false;

  async start(): Promise<void> {
    this.running = true;
    log.info("serving script VM requests", { slots: RPC_SLOTS });
    await Promise.all(Array.from({ length: RPC_SLOTS }, () => this.loop()));
  }

  stop(): void {
    this.running = false;
  }

  close(): void {
    this.connection.disconnect();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const popped = await this.connection.brpop(keys.rpcRequests, POP_TIMEOUT_SECONDS);
        if (!popped) continue;

        const parsed = rpcRequestSchema.safeParse(safeJson(popped[1]));
        if (!parsed.success) {
          log.warn("discarded a malformed request", { issues: parsed.error.issues });
          continue;
        }
        await this.serve(parsed.data);
      } catch (cause) {
        if (!this.running) return;
        log.error("rpc slot recovering", { error: describeError(cause) });
        await sleep(1000);
      }
    }
  }

  private async serve(request: RpcRequest): Promise<void> {
    const reply = new Reply(request.id);
    let target: ExecutionTarget | undefined;

    try {
      // A connection per request. Scans are cached by the control plane and
      // downloads are occasional, so pooling here would be machinery guarding
      // against a cost nobody has measured.
      target = await this.connect(request.target);

      switch (request.kind) {
        case "scan":
          await reply.json(await scan(target, request.scriptPath));
          break;
        case "listFiles":
          await reply.json(
            await listFiles(target, request.directory, request.since ? new Date(request.since) : null),
          );
          break;
        case "readFile":
          await readFile(target, request.path, request.maxBytes, reply);
          break;
      }
      await reply.end();
    } catch (cause) {
      log.error("request failed", {
        kind: request.kind,
        host: request.target.host,
        error: describeError(cause),
      });
      await reply.error({
        code: "upstream_unavailable",
        message: `The script VM did not answer: ${describeError(cause)}`,
      });
    } finally {
      target?.close();
    }
  }

  private connect(target: SshTarget): Promise<ExecutionTarget> {
    return connectTo({ host: target.host, port: target.port, username: target.username });
  }
}

/**
 * ADR-004 — one directory, every file's header, and never a body.
 *
 * A file whose header will not parse is still a script and is still listed. An
 * unreadable header must never keep a script out of the catalog: it makes the
 * criticality `unknown`, which ADR-003 already has an answer for.
 */
async function scan(target: ExecutionTarget, scriptPath: string): Promise<ScanResult> {
  // Flat: FA-04.2 has no version management and there are no sub-areas beneath
  // an area, so a script directory is a list of scripts rather than a tree.
  const listing = await target.list(scriptPath, { maxDepth: 0, maxEntries: 1_000 });

  const scripts = await Promise.all(
    listing.entries.map(async (entry) => {
      let header: Record<string, unknown> | null = null;
      try {
        const head = await target.readHead(`${scriptPath}/${entry.name}`, HEADER_READ_BYTES);
        header = parseScriptHeader(head.toString("utf8")) as Record<string, unknown> | null;
      } catch (cause) {
        log.debug("could not read a script header", {
          file: entry.name,
          error: describeError(cause),
        });
      }

      return {
        fileName: entry.name,
        absolutePath: `${scriptPath}/${entry.name}`,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt.toISOString(),
        header,
        executable: entry.executable,
      };
    }),
  );

  log.debug("scanned a script directory", { scriptPath, count: scripts.length });
  return { scripts };
}

async function listFiles(
  target: ExecutionTarget,
  directory: string,
  since: Date | null,
): Promise<ListFilesResult> {
  const listing = await target.list(directory, { since });
  return {
    files: listing.entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt.toISOString(),
    })),
    truncated: listing.truncated,
  };
}

/**
 * FA-09.2. The header goes first so the caller can set its own response headers
 * before a byte of content arrives, then the file follows in chunks — nothing
 * buffers the whole file, here or at the other end.
 */
async function readFile(
  target: ExecutionTarget,
  path: string,
  maxBytes: number,
  reply: Reply,
): Promise<void> {
  const facts = await target.stat(path);
  if (!facts) {
    await reply.error({ code: "not_found", message: "No such file on the script VM" });
    return;
  }

  await reply.json({
    path,
    sizeBytes: facts.sizeBytes,
    truncated: facts.sizeBytes > maxBytes,
  } satisfies ReadFileHeader);

  let pending: Buffer[] = [];
  let pendingBytes = 0;

  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    await reply.chunk(Buffer.concat(pending));
    pending = [];
    pendingBytes = 0;
  };

  await target.read(path, maxBytes, async (chunk) => {
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes >= READ_CHUNK_BYTES) await flush();
  });
  await flush();
}

/** One reply list, written frame by frame (see RPC_FRAME in the contracts). */
class Reply {
  private readonly key: string;

  constructor(requestId: string) {
    this.key = keys.rpcReply(requestId);
  }

  json(payload: unknown): Promise<void> {
    return this.push(RPC_FRAME.JSON, Buffer.from(JSON.stringify(payload), "utf8"));
  }

  chunk(data: Buffer): Promise<void> {
    return this.push(RPC_FRAME.CHUNK, data);
  }

  end(): Promise<void> {
    return this.push(RPC_FRAME.END, Buffer.alloc(0));
  }

  async error(error: RpcError): Promise<void> {
    await this.push(RPC_FRAME.ERROR, Buffer.from(JSON.stringify(error), "utf8"));
  }

  private async push(frame: number, payload: Buffer): Promise<void> {
    const commands = redis();
    await commands.rpush(this.key, Buffer.concat([Buffer.from([frame]), payload]));
    // Refreshed on every frame rather than set once: a slow download must not
    // have its own reply expire underneath it.
    await commands.expire(this.key, REPLY_TTL_SECONDS);
  }
}

function safeJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
