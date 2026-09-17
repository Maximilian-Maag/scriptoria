# syntax=docker/dockerfile:1

# The control plane. Built from the workspace root — `docker build -f
# apps/backend/Dockerfile .` — because a pnpm workspace app cannot be built from
# its own directory: it depends on four sibling packages and on one lockfile
# that describes all of them.
#
# NFR-01 puts this in a private network with no route out, so everything the
# image needs is in the image. Nothing is fetched when a container starts.
#
# Two dependency trees are installed rather than one. The build needs the dev
# dependencies and the runtime must not carry them, and `pnpm install --prod`
# over an existing tree adds to it rather than thinning it — so the production
# tree is built once, from a clean base, and the build's tree is never shipped.

# ADR-010 — why these images ship TypeScript and run it through tsx.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV CI=true

# The manifests, and only the manifests: this layer is rebuilt when a dependency
# changes, not when a line of source does. `--filter backend...` is the app *and
# the packages it depends on*, so the frontend's and the runner's dependencies
# never enter this image.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/backend/package.json apps/backend/

# ── Build ────────────────────────────────────────────────────────────────────
#
# No build-time environment. `defineConfig` is lazy on purpose (see
# packages/config), so a build that needs a variable to succeed is a build that
# reads configuration at import time — and this is where that goes red.
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "backend..."
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/backend apps/backend
RUN pnpm --filter backend exec next build
# Build cache, and the largest thing in the tree. Nothing reads it at runtime.
RUN rm -rf apps/backend/.next/cache

# ── The production dependency tree ───────────────────────────────────────────
FROM manifests AS proddeps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "backend..." --prod
# The build's compiler, which the runtime never invokes. pnpm installs the glibc
# build alongside the musl one; this base image is musl.
RUN rm -rf node_modules/.pnpm/@next+swc-linux-x64-gnu@*

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime

ENV NODE_ENV=production
ENV BACKEND_PORT=3001

# The dependency tree first, then the source over the top of it. COPY merges, so
# the `node_modules` directories pnpm created inside each workspace package
# survive having the package's own sources copied in after them.
COPY --from=proddeps --chown=node:node /app /app
COPY --chown=node:node tsconfig.base.json tsconfig.json ./
COPY --chown=node:node packages packages
COPY --chown=node:node apps/backend apps/backend
COPY --from=build --chown=node:node /app/apps/backend/.next apps/backend/.next

# The app is started through tsx rather than from a compiled bundle: the
# entrypoint is `server.ts`, and ADR-007 explains why that file exists at all.
# tsx is a production dependency of this app for exactly that reason.
#
# The image runs as `node`, and the deployment runs the container rootless
# (NFR-05). Neither is sufficient alone and both are cheap.
USER node
EXPOSE 3001

# The same endpoint the monitoring system polls (NFR-16). `wget` is in busybox;
# adding curl for a nicer flag would be adding a package for nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/api/health || exit 1

WORKDIR /app/apps/backend
CMD ["node", "--import", "tsx", "server.ts"]
