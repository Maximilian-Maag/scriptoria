# ADR-010 — The images ship TypeScript and run it through tsx

**Status:** Accepted
**Context:** NFR-01, NFR-11, ADR-002, ADR-007

## Context

Three processes deploy: the frontend, the control plane and the runner. The two web tiers are
Next.js applications with custom servers — the control plane's exists because a route handler
cannot hold a WebSocket open for the life of a run (ADR-007), and the frontend's exists so both
tiers start the same way. The runner is plain Node with no build output at all: its `build`
script is `tsc --noEmit`.

The workspace packages ship TypeScript source rather than a `dist`, deliberately, so that a
stale build artefact can never be what the three apps disagree over.

## Decision

Each image installs the workspace, builds what Next.js needs, and runs the app's own
`server.ts` (or `src/index.ts`) through `tsx`. Nothing is bundled ahead of time, and `tsx` is a
production dependency of all three apps — which it always was in fact, since `start` has always
been `tsx server.ts`; it was declared as a development dependency by accident.

Each image resolves **two** dependency trees and ships one: the build's, with its development
dependencies, and a production tree resolved separately from a clean base.

## Why not compile to a bundle

Next's `output: "standalone"` traces a minimal runtime for the server *it* generates — and
neither app runs that server. Bundling the custom server instead means an esbuild step with a
hand-maintained list of externals, and a list of externals is a thing that is correct until
somebody adds a dependency. The failure mode is a module missing at runtime in production and
present in every test.

`tsx` costs about 22 MB of esbuild in each image and removes that whole class of problem. The
source in the image is also the source in the repository, which is worth something when reading
a stack trace from a machine nobody can attach a debugger to (NFR-01).

## Why two trees rather than one

Measured, not assumed. `pnpm install --prod` over an existing tree adds to it rather than
thinning it — the first attempt shipped the build's tree and came out 1.24 GB. `pnpm prune
--prod` is worse in a filtered workspace install: it empties the app's own `node_modules`
entirely, and the container dies with `Cannot find package 'tsx'`. Resolving the production
tree separately is what makes the images 832 MB, 839 MB and 302 MB.

## Consequences

- A container starts by transpiling on demand, so the first request after a start is slower
  than it would be from a bundle. For a platform whose typical action takes a second to a
  minute (NFR-10), this is not a cost anybody will notice.
- The images are large by container standards. They are vendored on purpose: NFR-01 means
  nothing is fetched when a container starts, and the remaining bulk is Next.js itself.
- One value cannot be supplied at runtime. `NEXT_PUBLIC_TERMINAL_WS_URL` is compiled into the
  client bundle by `next build`, so the terminal's address is a property of the *image* and is
  passed as a build argument. Setting it on the container does nothing, and getting it wrong is
  silent — the bundle keeps the development default and the terminal, which is the product's
  critical path, fails to connect with nothing in any log to say why.
