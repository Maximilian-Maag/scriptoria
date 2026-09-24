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
import { request } from "@playwright/test";
import { ACCOUNTS, BASE_URL, REFERENCE_AREA, REQUIRED_SERVICES } from "./env";

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

/**
 * Waits for the *applications*, not just for the containers.
 *
 * `reachable` above only proves the four containers are listening. The three
 * application processes are started by the suite's own `webServer`, and its
 * readiness signal is the frontend's `/login` — so the specs can begin while the
 * control plane is still compiling and while the runner is still starting. The
 * first request that needs the runner then waits out the control plane's
 * 30-second RPC timeout, races the frontend's identical proxy timeout, and
 * surfaces as `502 upstream_unavailable` in whichever spec happened to need the
 * catalog first. Every other spec in that job fails the same way for the same
 * reason, which reads as "the whole suite is broken" rather than "one process
 * never started". That is the failure this file exists to prevent, and the one
 * it did not yet cover.
 *
 * The catalog is the readiness signal because it is the only request that proves
 * the whole chain at once: frontend → control plane → runner → SSH → the
 * fixture's directory. Everything a spec does after that is a feature rather
 * than a prerequisite.
 */
async function waitForTheApplications(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const api = await request.newContext({ baseURL: BASE_URL });
  let last = "nothing has answered yet";

  try {
    while (Date.now() < deadline) {
      try {
        const signIn = await api.post("/api/proxy/auth/login", { data: ACCOUNTS.branch });

        if (signIn.ok()) {
          const areas = await api.get("/api/proxy/areas");

          if (areas.ok()) {
            const list = (await areas.json()) as Array<{ id: string; name: string }>;
            const area = list.find((candidate) => candidate.name === REFERENCE_AREA.name);

            if (!area) {
              last = `the areas list does not contain ${REFERENCE_AREA.name}`;
            } else {
              const catalog = await api.get(`/api/proxy/areas/${area.id}/scripts`);
              if (catalog.ok()) return;
              last = `the catalog answered ${catalog.status()}: ${(await catalog.text()).slice(0, 200)}`;
            }
          } else {
            last = `the areas list answered ${areas.status()}`;
          }
        } else {
          last = `signing in answered ${signIn.status()}: ${(await signIn.text()).slice(0, 200)}`;
        }
      } catch (cause) {
        // Not listening yet is an ordinary outcome while the three processes
        // come up, and it is not a failure of the run.
        last = cause instanceof Error ? cause.message : String(cause);
      }

      await new Promise((resume) => setTimeout(resume, 2_000));
    }

    throw new Error(
      [
        `The applications did not answer the catalog within ${Math.round(timeoutMs / 1_000)} seconds.`,
        `  · last answer: ${last}`,
        "",
        "The runner is the usual reason, and it is the one process with no port to poll: the",
        "suite waits only for the frontend, so a runner that never registered leaves every",
        "request that needs the catalog waiting out the control plane's 30-second RPC timeout.",
        "Its own log lines are printed above this message by the web server.",
        "",
        "Check that the fixture key exists (`make fixtures-key`), that the script-VM fixture is",
        "reachable on its SSH port, and that the runner started at all.",
        "",
      ].join("\n"),
    );
  } finally {
    await api.dispose();
  }
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
  const skipsHostKey =
    (process.env["SSH_SKIP_HOST_KEY_VERIFICATION"] ?? "").toLowerCase() === "true";
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

  await waitForTheApplications();
}
