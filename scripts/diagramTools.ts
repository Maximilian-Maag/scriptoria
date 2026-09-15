/**
 * Makes the two container images that render the C4 model available locally.
 *
 * This is split out of diagrams.ts because it is the only step that needs the
 * network. Once the images are local, `make diagrams` runs offline — which
 * matters, because the environment this platform deploys into has no internet
 * at runtime (NFR-01) and the diagrams are part of what ships with it.
 *
 * The renderers run in containers rather than from jars on the host, so that
 * rendering the architecture needs no JRE anywhere. Docker is already required
 * for the dev stack; a Java toolchain would be a second one, installed for
 * nothing but pictures.
 *
 * Both images are pinned by digest, and the digest is verified after the pull.
 * That is not ceremony:
 *
 *   - `structurizr/cli:latest` was replaced upstream by a deprecation stub that
 *     prints a migration notice, writes nothing, and exits 0. A moving tag here
 *     fails silently — `make diagrams` would report success and produce an
 *     empty directory. 2025.11.09 is the last release that renders, and is one
 *     day newer than the Structurizr Lite pin in the dev stack.
 *   - PlantUML's layout changes between releases. An unpinned renderer means a
 *     diff in every diagram the next time anyone regenerates them.
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface PinnedImage {
  /** What this image is for, in the log line. */
  readonly role: string;
  readonly repository: string;
  readonly tag: string;
  /** Verified after the pull. The tag alone is not a guarantee. */
  readonly digest: string;
}

export const STRUCTURIZR_CLI: PinnedImage = {
  role: "DSL → PlantUML",
  repository: "structurizr/cli",
  tag: "2025.11.09",
  digest: "sha256:0399ac8e24c16e41277cfcec22caa29e4775013e5395c0720016828426d62749",
};

export const PLANTUML: PinnedImage = {
  role: "PlantUML → PNG/PDF",
  repository: "plantuml/plantuml",
  tag: "1.2026.8",
  digest: "sha256:d08610df482510844382caa4e016ba2bf7e3231f630f02ee12f250f3416c62b1",
};

/** Named individually above because the caller needs each one by role, not by index. */
export const IMAGES: readonly PinnedImage[] = [STRUCTURIZR_CLI, PLANTUML];

export const imageRef = (image: PinnedImage): string => `${image.repository}:${image.tag}`;

/** A docker invocation that captures output instead of inheriting the terminal. */
function docker(args: readonly string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Fails with an actionable message rather than letting the first `docker run`
 * fail with something about a socket.
 */
export function requireDocker(): void {
  if (!docker(["version", "--format", "{{.Server.Version}}"]).ok) {
    throw new Error(
      "docker is not available, or its daemon is not reachable.\n" +
        "The C4 renderers run in containers so that no JRE is needed on the host.\n" +
        "Podman users: alias docker=podman works, the invocations are plain run/pull.",
    );
  }
}

/** The digests docker holds for an image that is already local. */
function localDigests(ref: string): string[] {
  const inspected = docker(["image", "inspect", "--format", '{{join .RepoDigests "\\n"}}', ref]);
  if (!inspected.ok) return [];
  return inspected.stdout
    .split("\n")
    .map((line) => line.split("@")[1])
    .filter((digest): digest is string => Boolean(digest));
}

/**
 * Pulls an image unless it is already present at the pinned digest, then
 * verifies what is present. Returns whether anything was fetched, so the caller
 * can stay quiet on the common path.
 */
export function ensureImage(image: PinnedImage): { pulled: boolean } {
  const ref = imageRef(image);

  if (localDigests(ref).includes(image.digest)) {
    return { pulled: false };
  }

  process.stdout.write(`  pulling ${ref}  (${image.role})\n`);
  const pulled = docker(["pull", "--quiet", `${image.repository}@${image.digest}`]);
  if (!pulled.ok) {
    throw new Error(`could not pull ${ref}:\n${pulled.stderr || pulled.stdout}`);
  }

  // Pulling by digest leaves the image without the tag the run commands use.
  const tagged = docker(["tag", `${image.repository}@${image.digest}`, ref]);
  if (!tagged.ok) {
    throw new Error(`could not tag ${ref}:\n${tagged.stderr || tagged.stdout}`);
  }

  if (!localDigests(ref).includes(image.digest)) {
    throw new Error(
      `${ref} is present but not at the pinned digest.\n` +
        `  expected ${image.digest}\n` +
        `  found    ${localDigests(ref).join(", ") || "(none)"}`,
    );
  }

  return { pulled: true };
}

export function ensureImages(): void {
  requireDocker();
  let pulled = 0;
  for (const image of IMAGES) {
    if (ensureImage(image).pulled) pulled += 1;
  }
  if (pulled > 0) {
    process.stdout.write(`Renderers ready (${pulled} pulled).\n`);
  }
}

// `make diagrams-install` runs this file directly; diagrams.ts imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureImages();
    process.stdout.write(IMAGES.map((i) => `  ${imageRef(i)}  ${i.role}`).join("\n") + "\n");
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
