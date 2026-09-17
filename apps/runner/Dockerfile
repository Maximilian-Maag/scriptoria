# syntax=docker/dockerfile:1

# The runner. The one component that is not Next.js — it listens on no port and
# serves no page, so there is no web application here for NFR-11 to apply to.
#
# It holds the SSH and PTY session to the script VM, which is why it is its own
# image and its own process: a control plane restart must not kill a running
# script, and it cannot if the PTY is not in the control plane.
#
# Shaped like the other two images; the control plane's comments explain the two
# dependency trees. There is no bundling step here and no `.next` — `build` in
# this package is `tsc --noEmit`, and the runner ships its TypeScript source and
# is run by tsx exactly as the two web tiers are.

# ADR-010 — why these images ship TypeScript and run it through tsx.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV CI=true

FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/runner/package.json apps/runner/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "runner..."
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/runner apps/runner
RUN pnpm --filter runner exec tsc --noEmit

FROM manifests AS proddeps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "runner..." --prod

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=proddeps --chown=node:node /app /app
COPY --chown=node:node tsconfig.base.json tsconfig.json ./
COPY --chown=node:node packages packages
COPY --chown=node:node apps/runner apps/runner

USER node

# No EXPOSE and no HEALTHCHECK, by design. This process accepts no connection —
# it claims work off the Redis queue and dials out over SSH — so there is
# nothing to poll. Whether it is alive shows in the queue depth and in the runs
# it fails to claim, which is where NFR-16 wants that answered anyway.

WORKDIR /app/apps/runner
CMD ["node", "--import", "tsx", "src/index.ts"]
