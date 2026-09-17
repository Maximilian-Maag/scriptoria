import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadRunnerConfig } from "@scriptoria/config";
import { isKnownHostKey, parseKnownHosts, type KnownHostEntry } from "./knownHosts";
import { log } from "../log";

/**
 * The only two files this process is trusted with: the private key it presents
 * to the script VM, and the host keys it is willing to accept back.
 *
 * Both are read once at startup rather than per connection. A key that is
 * missing or unreadable must stop the process from starting, not produce a run
 * that fails five minutes later with "Permission denied (publickey)".
 */

/**
 * A relative path in the configuration is relative to the repository, not to
 * whichever directory the process happened to start in — `infra/sshd/keys/...`
 * has to mean the same file whether the runner was started from the root or
 * from `apps/runner`.
 */
export function resolveFromRepository(path: string): string {
  if (isAbsolute(path)) return path;

  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth++) {
    const candidate = resolve(dir, path);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), path);
}

export interface SshCredentials {
  privateKey: Buffer;
  passphrase: string | undefined;
  knownHosts: KnownHostEntry[];
  /** Dev only, against a fixture whose host key is regenerated on every build. */
  skipHostKeyVerification: boolean;
}

let cached: SshCredentials | undefined;

export function loadCredentials(): SshCredentials {
  if (cached) return cached;
  const config = loadRunnerConfig();

  const keyPath = resolveFromRepository(config.SSH_PRIVATE_KEY_PATH);
  if (!existsSync(keyPath)) {
    throw new Error(
      `No SSH private key at ${keyPath}. ` +
        `Generate the development keypair with \`make fixtures-key\`, or point ` +
        `SSH_PRIVATE_KEY_PATH at the deployment's key.`,
    );
  }

  const skip = config.SSH_SKIP_HOST_KEY_VERIFICATION;
  const knownHostsPath = resolveFromRepository(config.SSH_KNOWN_HOSTS_PATH);
  let knownHosts: KnownHostEntry[] = [];

  if (existsSync(knownHostsPath)) {
    knownHosts = parseKnownHosts(readFileSync(knownHostsPath, "utf8"));
  } else if (!skip) {
    throw new Error(
      `No known_hosts at ${knownHostsPath}. ADR-001 pins the host key per script ` +
        `VM: trust on first use inside an isolated zone is not trust. Populate it ` +
        `with \`ssh-keyscan\`, or set SSH_SKIP_HOST_KEY_VERIFICATION=true for the ` +
        `development fixture.`,
    );
  }

  if (skip) {
    // Loud, and at warn level, because this is the one setting that turns the
    // isolation in NFR-01 into decoration. It exists for the dev fixture, whose
    // host key is regenerated on every image build.
    log.warn("host key verification is disabled — development fixture only", {
      knownHostsPath,
    });
  }

  cached = {
    privateKey: readFileSync(keyPath),
    passphrase: config.SSH_PRIVATE_KEY_PASSPHRASE || undefined,
    knownHosts,
    skipHostKeyVerification: skip,
  };
  return cached;
}

/** The callback ssh2 asks before it trusts the server it just reached. */
export function hostKeyVerifier(host: string, port: number): (key: Buffer) => boolean {
  const credentials = loadCredentials();
  return (key: Buffer) => {
    if (credentials.skipHostKeyVerification) return true;
    const known = isKnownHostKey(credentials.knownHosts, host, port, key);
    if (!known) {
      log.error("rejected an unpinned host key", { host, port });
    }
    return known;
  };
}
