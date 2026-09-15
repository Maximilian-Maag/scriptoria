/**
 * Renders the C4 diagrams from docs/architecture/workspace.dsl.
 *
 * The DSL is the source of truth. Everything this writes is generated and
 * gitignored — docs/architecture/diagrams/ for the output, .diagrams/ for the
 * intermediates — so a diagram is never reviewed instead of the model that
 * produced it.
 *
 *   --png   one PNG per view
 *   --pdf   one vector PDF containing every view in reading order
 *
 * Neither flag renders both, which is what `make diagrams` asks for.
 *
 * Two stages, each in a pinned container (see diagramTools.ts):
 *
 *   workspace.dsl  ──structurizr/cli──▶  .diagrams/puml/*.puml
 *                  ──plantuml────────▶  docs/architecture/diagrams/
 *
 * The containers run as the invoking uid. Structurizr Lite, which shares this
 * directory, runs as root inside its own container and leaves root-owned files
 * behind; doing the same here would mean a sudo to clean the output.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

import { ensureImages, imageRef, PLANTUML, STRUCTURIZR_CLI } from "./diagramTools.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const architectureDir = join(repoRoot, "docs", "architecture");
const workspaceDsl = join(architectureDir, "workspace.dsl");
const intermediateDir = join(repoRoot, ".diagrams", "puml");
const outputDir = join(architectureDir, "diagrams");
const combinedPdf = join(outputDir, "scriptoria-c4.pdf");

/**
 * The views, in the order a reader should meet them: zoom in from the system
 * boundary to the components, then step out to where it all runs. This is also
 * the page order of the combined PDF, so it is stated once, here, rather than
 * being whatever readdir happened to return.
 *
 * Keys must match the view keys in workspace.dsl. A missing one is an error
 * rather than a silently shorter PDF — see renderTargets().
 */
const READING_ORDER = [
  "SystemContext",
  "Container",
  "Component_Frontend",
  "Component_Backend_Requests",
  "Component_Backend_Auth",
  "Component_Backend_Data",
  "Component_Runner",
  "Deployment_Local",
  "Deployment_Staging",
  "Deployment_Production",
  "Deployment_Portability",
] as const;

function run(command: string, args: readonly string[], what: string): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${what} failed (exit ${result.status ?? "signal"}):\n` +
        `${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return (result.stdout ?? "").trim();
}

/**
 * How many times a container is started before its failure is believed.
 *
 * A bind-mounted directory occasionally comes up empty, or missing, in a
 * container started moments after that directory was written to from the host.
 * It has shown up twice here, differently each time: once as a JVM that died at
 * startup with "Could not determine current working directory", once as PlantUML
 * exiting 50 with "No file found" over a directory that demonstrably held all
 * seven files. Both retried clean, on unchanged inputs.
 *
 * I have not root-caused it below the daemon, so this does not pretend to be a
 * fix. It is safe as a retry because each stage is pure — same inputs, same
 * outputs, no accumulated state — and because the inputs are checked to exist on
 * the host in renderTargets() before any container starts. A genuine "the file
 * really is missing" failure is caught there, not here.
 */
const CONTAINER_ATTEMPTS = 3;

/** docker run, as the invoking user, with no network — the renderers need none. */
function dockerRun(
  mounts: readonly string[],
  image: string,
  args: readonly string[],
  what: string,
  env: Readonly<Record<string, string>> = {},
): void {
  const argv = [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...mounts.flatMap((mount) => ["-v", mount]),
    image,
    ...args,
  ];

  for (let attempt = 1; ; attempt += 1) {
    try {
      run("docker", argv, what);
      return;
    } catch (error) {
      if (attempt >= CONTAINER_ATTEMPTS) throw error;
      process.stdout.write(`  ${what} did not start cleanly, retrying (${attempt})\n`);
    }
  }
}

/**
 * Exports every view to PlantUML, then normalises the filenames.
 *
 * structurizr-cli prefixes each file with the workspace name and also emits a
 * `-key` legend per view. The legends duplicate the styles block and are not
 * diagrams of anything, so they are dropped; the prefix goes because the output
 * is already in a directory called diagrams/.
 */
function exportToPlantuml(): void {
  // Clear the contents rather than the directory. Removing and recreating a
  // directory that is about to be bind-mounted races the daemon, which resolves
  // the mount to the inode that was just unlinked; the container then starts
  // with no working directory and the JVM dies before main(). Seen once, and
  // once is enough for something a build step depends on.
  mkdirSync(intermediateDir, { recursive: true });
  for (const stale of readdirSync(intermediateDir)) {
    rmSync(join(intermediateDir, stale), { recursive: true, force: true });
  }

  dockerRun(
    [`${architectureDir}:/ws:ro`, `${intermediateDir}:/out`],
    imageRef(STRUCTURIZR_CLI),
    ["export", "-workspace", "/ws/workspace.dsl", "-format", "plantuml", "-output", "/out"],
    "structurizr-cli export",
  );

  for (const file of readdirSync(intermediateDir)) {
    if (!file.endsWith(".puml")) continue;
    if (file.endsWith("-key.puml")) {
      rmSync(join(intermediateDir, file));
      continue;
    }
    const key = file.replace(/^structurizr-/, "");
    if (key !== file) renameSync(join(intermediateDir, file), join(intermediateDir, key));
  }

  for (const file of readdirSync(intermediateDir)) {
    if (file.endsWith(".puml")) spaceOut(join(intermediateDir, file));
  }
}

/**
 * Separation between ranks, and between nodes within a rank, in the exported
 * diagrams. These are what stop the boxes from touching and the edge labels
 * from landing on top of them.
 *
 * They are applied here rather than in workspace.dsl because the DSL's
 * `autoLayout` figures serve a second renderer: Structurizr Lite, at :8088,
 * lays the model out with them directly, while the PlantUML export divides
 * rankSeparation by 5 and nodeSeparation by 10 before writing its skinparams.
 * One pair of numbers cannot be right for both — the values that make the
 * exported PNGs readable put Lite's canvas into the tens of thousands of
 * pixels. So the DSL keeps the figures tuned for Lite, and the export, which
 * knows it is producing a static picture nobody can pan, overrides them.
 */
const RANK_SEPARATION = 300;
const NODE_SEPARATION = 180;

/** Rewrites the separation skinparams the exporter emitted. */
function spaceOut(file: string): void {
  const original = readFileSync(file, "utf8");
  const spaced = original
    .replace(/^skinparam ranksep \d+$/m, `skinparam ranksep ${RANK_SEPARATION}`)
    .replace(/^skinparam nodesep \d+$/m, `skinparam nodesep ${NODE_SEPARATION}`);

  // The exporter has always emitted both. If that changes, the diagrams would
  // quietly go back to being unreadable, so say so instead.
  if (spaced === original) {
    throw new Error(
      `${file} has no ranksep/nodesep to override — the exporter's output has changed.\n` +
        "Check what structurizr-cli now emits before trusting the rendered diagrams.",
    );
  }
  writeFileSync(file, spaced);
}

/**
 * The .puml files to render, in reading order, failing loudly if the DSL and
 * READING_ORDER have drifted apart. A view added to workspace.dsl and not here
 * would otherwise be exported and then quietly never rendered.
 */
function renderTargets(): string[] {
  const exported = readdirSync(intermediateDir)
    .filter((file) => file.endsWith(".puml"))
    .map((file) => file.replace(/\.puml$/, ""));

  const missing = READING_ORDER.filter((key) => !exported.includes(key));
  if (missing.length > 0) {
    throw new Error(
      `workspace.dsl did not produce: ${missing.join(", ")}.\n` +
        "Either the view key changed or the view was removed.",
    );
  }

  const unlisted = exported.filter(
    (key) => !READING_ORDER.includes(key as (typeof READING_ORDER)[number]),
  );
  if (unlisted.length > 0) {
    throw new Error(
      `workspace.dsl has views that READING_ORDER does not place: ${unlisted.join(", ")}.\n` +
        "Add them to READING_ORDER in scripts/diagrams.ts so the PDF stays complete.",
    );
  }

  return [...READING_ORDER];
}

/**
 * PlantUML crops any raster output wider or taller than PLANTUML_LIMIT_SIZE,
 * which defaults to 4096. It does not scale to fit and it does not warn: the
 * backend component view came out cut off mid-box down the right-hand edge,
 * losing the repository layer, the session store and three external systems,
 * while still looking like a finished diagram.
 *
 * The component views are the wide ones — the largest is around 5700px. This
 * is set well clear of that so that adding a component does not silently start
 * truncating again. It is a ceiling, not a canvas size, so the cost of headroom
 * is nothing; PlantUML still renders each diagram at its natural extent.
 */
const PLANTUML_LIMIT_SIZE = 16384;

function plantuml(format: "png" | "pdf", keys: readonly string[]): void {
  dockerRun(
    [`${intermediateDir}:/data`],
    imageRef(PLANTUML),
    [`-t${format}`, ...keys.map((key) => `/data/${key}.puml`)],
    `plantuml -t${format}`,
    { PLANTUML_LIMIT_SIZE: String(PLANTUML_LIMIT_SIZE) },
  );
}

/** Width and height from a PNG's IHDR chunk, which is always the first one. */
function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(0, 24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * Moves the rendered PNGs out and checks none of them was cropped.
 *
 * Kept separate from the render call so that every container runs before
 * anything is moved out from under the mount — a host-side rename between two
 * container starts is one of the two shapes the bind-mount flake has taken.
 */
function collectPng(keys: readonly string[]): void {
  const truncated: string[] = [];
  for (const key of keys) {
    const rendered = join(intermediateDir, `${key}.png`);
    const { width, height } = pngSize(rendered);
    // A diagram that lands exactly on the ceiling was cropped to reach it.
    if (width >= PLANTUML_LIMIT_SIZE || height >= PLANTUML_LIMIT_SIZE) {
      truncated.push(`${key} (${width}×${height})`);
    }
    renameSync(rendered, join(outputDir, `${key}.png`));
  }

  if (truncated.length > 0) {
    throw new Error(
      `PlantUML cropped these to PLANTUML_LIMIT_SIZE=${PLANTUML_LIMIT_SIZE}: ${truncated.join(", ")}.\n` +
        "The PNGs are incomplete at the right or bottom edge. Raise PLANTUML_LIMIT_SIZE\n" +
        "in scripts/diagrams.ts and render again.",
    );
  }

  process.stdout.write(`  ${keys.length} PNG → docs/architecture/diagrams/\n`);
}

/**
 * PlantUML writes one PDF per diagram, so the pages are stitched here. pdf-lib
 * is pure JavaScript: the alternative was pdfunite or Ghostscript, which would
 * have put a tool back on the host after the renderers were containerised to
 * get them off it.
 */
async function combinePdf(keys: readonly string[]): Promise<void> {
  const combined = await PDFDocument.create();
  combined.setTitle("Scriptoria — C4 model");
  combined.setSubject("Generated from docs/architecture/workspace.dsl. Do not edit.");
  combined.setProducer("scripts/diagrams.ts");

  for (const key of keys) {
    const page = join(intermediateDir, `${key}.pdf`);
    const source = await PDFDocument.load(readFileSync(page));
    const copied = await combined.copyPages(source, source.getPageIndices());
    for (const it of copied) combined.addPage(it);
    rmSync(page);
  }

  writeFileSync(combinedPdf, await combined.save());
  process.stdout.write(`  ${keys.length} views → docs/architecture/diagrams/scriptoria-c4.pdf\n`);
}

async function main(): Promise<void> {
  const wantPng = process.argv.includes("--png");
  const wantPdf = process.argv.includes("--pdf");

  if (!wantPng && !wantPdf) {
    process.stderr.write("Nothing to do: pass --png, --pdf, or both.\n");
    process.exit(2);
  }
  if (!existsSync(workspaceDsl)) {
    throw new Error(`the model is missing: ${workspaceDsl}`);
  }

  ensureImages();
  mkdirSync(outputDir, { recursive: true });

  exportToPlantuml();
  const keys = renderTargets();

  // Every container first, then the host-side work. Nothing is moved out of the
  // bind-mounted directory while another container still has to start against it.
  if (wantPng) plantuml("png", keys);
  if (wantPdf) plantuml("pdf", keys);

  if (wantPng) collectPng(keys);
  if (wantPdf) await combinePdf(keys);
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
