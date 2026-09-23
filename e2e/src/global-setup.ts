/**
 * Fails the run before the first spec, with something a person can act on.
 *
 * Every check here is a prerequisite whose absence is both common on a fresh
 * checkout and expensive to diagnose from a failing spec: a service that is not
 * up, a runner that cannot start because it has no SSH key or no host key to
 * trust, and a browser that was never downloaded. Without this they surface as
 * a login that does nothing and a catalog that answers 502 — three specs later
 * and one wrong hypothesis away from the actual cause.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "node:net";
import { REQUIRED_SERVICES } from "./env";

/** `e2e/src/` → the repository root, which is where `.env` and `infra/` live. */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");

function reachable(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve_) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve_(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export default async function globalSetup(): Promise<void> {
  const problems: string[] = [];

  for (const service of REQUIRED_SERVICES) {
    if (!(await reachable(service.host, service.port))) {
      problems.push(`${service.name} — nothing listening on ${service.host}:${service.port}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "The end-to-end stack is not running:",
        ...problems.map((line) => `  · ${line}`),
        "",
        "Bring it up with:",
        "  make dev            # postgres, redis, the directory and script-VM fixtures",
        "  make fixtures-key   # the runner's SSH keypair for the fixture",
        "  cp .env.example .env",
        "  make db-migrate && make db-seed",
        "",
      ].join("\n"),
    );
  }

  // The runner reads its key once at startup and refuses to start without it,
  // so every run would fail with `connect_failed` and nothing would say why.
  const keyPath = resolve(
    REPOSITORY_ROOT,
    process.env["SSH_PRIVATE_KEY_PATH"] ?? "infra/sshd/keys/id_ed25519",
  );
  if (!existsSync(keyPath)) {
    throw new Error(
      `No SSH private key at ${keyPath} — the runner will not start. ` +
        "Generate the fixture keypair with `make fixtures-key`.",
    );
  }

  // The configuration the applications read. `.env` is the documented dev
  // shape (README, Getting Started) and its absence is not fatal on its own —
  // a deployment or CI supplies the same variables directly — but with neither
  // in place the applications run with the *production* defaults, and the two
  // that break loudly are host-key verification (the runner refuses to start)
  // and `Secure` session cookies (the browser drops the cookie over plain
  // http, so signing in appears to do nothing at all).
  const hasEnvFile = existsSync(resolve(REPOSITORY_ROOT, ".env"));
  const skipsHostKey = (process.env["SSH_SKIP_HOST_KEY_VERIFICATION"] ?? "").toLowerCase() === "true";
  const hasKnownHosts = Boolean(process.env["SSH_KNOWN_HOSTS_PATH"]);

  if (!hasEnvFile && !skipsHostKey && !hasKnownHosts) {
    throw new Error(
      [
        "No `.env` in the repository root, and no SSH host-key configuration in the environment.",
        "The applications would start with their production defaults: the runner would refuse",
        "to start without a known_hosts file, and `Secure` session cookies would be dropped by",
        "the browser over plain http.",
        "",
        "Fix it the way the README does:",
        "  cp .env.example .env",
        "",
      ].join("\n"),
    );
  }
}
