# syntax=docker/dockerfile:1

# The user interface. Built from the workspace root, and shaped exactly like the
# control plane's image — one build, one deployment shape, one set of
# conventions (NFR-11). The comments there explain the two dependency trees.
#
# This tier holds the session cookie and proxies to the control plane. It
# reaches no database, no directory and no script VM, which is the point of it
# being a separate image: the browser talks only to this, and this talks only to
# the control plane.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
ENV CI=true

FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY apps/frontend/package.json apps/frontend/

FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "frontend..."
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/frontend apps/frontend

# `NEXT_PUBLIC_*` is inlined into the client bundle by `next build`; it is not
# read at runtime, and setting it on the container does nothing. So the
# terminal's WebSocket address is a property of the *image* and has to be
# supplied here, per environment. Getting it wrong is silent: the bundle keeps
# the development default and the terminal — the product's critical path — fails
# to connect, with nothing in any log to say why.
ARG NEXT_PUBLIC_TERMINAL_WS_URL=ws://localhost:3001
ENV NEXT_PUBLIC_TERMINAL_WS_URL=$NEXT_PUBLIC_TERMINAL_WS_URL

RUN pnpm --filter frontend exec next build
RUN rm -rf apps/frontend/.next/cache

FROM manifests AS proddeps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "frontend..." --prod
RUN rm -rf node_modules/.pnpm/@next+swc-linux-x64-gnu@*

FROM base AS runtime

ENV NODE_ENV=production
ENV FRONTEND_PORT=3000

COPY --from=proddeps --chown=node:node /app /app
COPY --chown=node:node tsconfig.base.json tsconfig.json ./
COPY --chown=node:node packages packages
COPY --chown=node:node apps/frontend apps/frontend
COPY --from=build --chown=node:node /app/apps/frontend/.next apps/frontend/.next

USER node
EXPOSE 3000

# There is no health route here, and adding one would be adding an endpoint for
# the monitor rather than for the product. The login page is served by the same
# process and is a truer check: if it renders, the tier is doing its job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/login || exit 1

WORKDIR /app/apps/frontend
CMD ["node", "--import", "tsx", "server.ts"]
