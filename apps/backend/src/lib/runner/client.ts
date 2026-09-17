import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import {
  RPC_FRAME,
  listFilesResultSchema,
  readFileHeaderSchema,
  rpcErrorSchema,
  scanResultSchema,
  type ListFilesResult,
  type ReadFileHeader,
  type RpcRequest,
  type ScanResult,
  type SshTarget,
} from "@scriptoria/contracts";
import { blockingConnection, keys, redis } from "../redis";
import { err, ok, type Result } from "../result";

/**
 * How the control plane asks the runner to look at a script VM.
 *
 * It cannot do it itself, and that is the design rather than a limitation:
 * ADR-001 puts the SSH key material in one container, and a control plane that
 * could read the script directory could also run what is in it. So the two
 * filesystem reads the product needs — the catalog scan and a result download —
 * are requests on a queue.
 *
 * The runner listens on no port, so there is no HTTP call to make here. A
 * request is a list entry; the reply is a list of frames drained in order.
 */

/** How long to wait for a worker to pick a request up and answer its first frame. */
const FIRST_FRAME_TIMEOUT_SECONDS = 30;
/** Between frames of a file that is already streaming. */
const NEXT_FRAME_TIMEOUT_SECONDS = 60;

export async function scanScripts(
  target: SshTarget,
  scriptPath: string,
): Promise<Result<ScanResult>> {
  return single({ kind: "scan", id: randomUUID(), target, scriptPath }, (payload) => {
    const parsed = scanResultSchema.safeParse(payload);
    return parsed.success ? ok(parsed.data) : err("internal", "The scan came back unreadable");
  });
}

export async function listFiles(
  target: SshTarget,
  directory: string,
  since: Date | null,
): Promise<Result<ListFilesResult>> {
  return single(
    {
      kind: "listFiles",
      id: randomUUID(),
      target,
      directory,
      since: since?.toISOString() ?? null,
    },
    (payload) => {
      const parsed = listFilesResultSchema.safeParse(payload);
      return parsed.success ? ok(parsed.data) : err("internal", "The listing came back unreadable");
    },
  );
}

/**
 * A result file, streamed (FA-09.2).
 *
 * The header arrives before the first byte of content, so a route can set
 * `Content-Length` and `Content-Disposition` and then hand the body straight to
 * the browser. Nothing on this path holds the whole file: not the runner, not
 * Redis, not this process.
 */
export async function readFile(
  target: SshTarget,
  path: string,
  maxBytes: number,
): Promise<Result<{ header: ReadFileHeader; body: ReadableStream<Uint8Array> }>> {
  const request: RpcRequest = { kind: "readFile", id: randomUUID(), target, path, maxBytes };
  const connection = blockingConnection();
  const replyKey = keys.rpcReply(request.id);

  try {
    await redis().lpush(keys.rpcRequests, JSON.stringify(request));

    const first = await nextFrame(connection, replyKey, FIRST_FRAME_TIMEOUT_SECONDS);
    if (!first.ok) {
      connection.disconnect();
      return first;
    }
    if (first.value.kind !== RPC_FRAME.JSON) {
      connection.disconnect();
      return err("internal", "The runner answered with no file header");
    }

    const header = readFileHeaderSchema.safeParse(json(first.value.payload));
    if (!header.success) {
      connection.disconnect();
      return err("internal", "The file header came back unreadable");
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const frame = await nextFrame(connection, replyKey, NEXT_FRAME_TIMEOUT_SECONDS);
        if (!frame.ok) {
          controller.error(new Error(frame.message));
          connection.disconnect();
          return;
        }
        if (frame.value.kind === RPC_FRAME.END) {
          controller.close();
          connection.disconnect();
          return;
        }
        controller.enqueue(new Uint8Array(frame.value.payload));
      },
      cancel() {
        // The browser navigated away mid-download. Dropping the connection is
        // the whole cleanup: the reply list expires on its own.
        connection.disconnect();
      },
    });

    return ok({ header: header.data, body });
  } catch (cause) {
    connection.disconnect();
    return err("upstream_unavailable", "The runner is not reachable", { cause });
  }
}

/** A request whose answer is one JSON frame followed by the end of the reply. */
async function single<T>(
  request: RpcRequest,
  decode: (payload: unknown) => Result<T>,
): Promise<Result<T>> {
  const connection = blockingConnection();
  try {
    await redis().lpush(keys.rpcRequests, JSON.stringify(request));

    const frame = await nextFrame(connection, keys.rpcReply(request.id), FIRST_FRAME_TIMEOUT_SECONDS);
    if (!frame.ok) return frame;
    if (frame.value.kind !== RPC_FRAME.JSON) {
      return err("internal", "The runner answered with no payload");
    }
    return decode(json(frame.value.payload));
  } catch (cause) {
    return err("upstream_unavailable", "The runner is not reachable", { cause });
  } finally {
    connection.disconnect();
  }
}

interface Frame {
  kind: number;
  payload: Buffer;
}

/**
 * Reads one frame, and turns the runner's own error frame into a `Result`
 * failure rather than an exception — an unreachable script VM is an ordinary
 * outcome here, not a bug in this process.
 */
async function nextFrame(
  connection: Redis,
  key: string,
  timeoutSeconds: number,
): Promise<Result<Frame>> {
  const popped = await connection.blpopBuffer(key, timeoutSeconds);
  if (!popped) {
    // No worker answered. Almost always means no runner is running, which is
    // worth saying plainly: the alternative is a spinner that never resolves.
    return err("timeout", "The runner did not answer. Is a worker running?");
  }

  const entry = popped[1];
  const kind = entry[0];
  const payload = entry.subarray(1);

  if (kind === RPC_FRAME.ERROR) {
    const parsed = rpcErrorSchema.safeParse(json(payload));
    return parsed.success
      ? err(parsed.data.code, parsed.data.message)
      : err("internal", "The runner failed and said nothing useful about it");
  }
  if (kind === undefined) return err("internal", "The runner sent an empty frame");

  return ok({ kind, payload });
}

function json(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}
