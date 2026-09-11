# syntax=docker/dockerfile:1

# Build context is the REPO ROOT, not this directory — the build needs the workspace lockfile and
# `packages/shared`. In Dokploy: Dockerfile path `apps/worker/Dockerfile`, build context `.`.

# The build stage stays on the machine that runs the build, never on the target architecture. What it
# produces is one bundled JavaScript file, and those bytes are the same for every platform, so
# emulating `pnpm install` and esbuild costs minutes and buys nothing. Measured cold on the
# arm64 → amd64 leg: 27 s with this pin, 1 min 32 s without it. Only the runtime stage below is
# emulated, and all it does there is install one Alpine package.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build

WORKDIR /repo
# pnpm installed explicitly rather than through corepack, which is on its way out of the Node images.
RUN npm install --global pnpm@11.16.0

# Manifests first: this layer only busts when a dependency actually changes, not on every code edit.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @fruitback/worker...

COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @fruitback/worker build

FROM node:26-alpine AS runtime

# `org.opencontainers.image.source` is the one label with an effect rather than a description: GHCR
# reads it to attach the package to this repository, which is what gives the package a README, a
# licence and the repository's own visibility. The volatile labels — version, revision, date — are
# added by the release workflow, which is the only place that knows them.
LABEL org.opencontainers.image.source="https://github.com/sakuga-software/fruitback"
LABEL org.opencontainers.image.description="Fruitback worker: the server half of the visual feedback widget."
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

# This is what refuses the in-memory store. It must stay in the stage that runs, and the build must
# not be given a `--target` that stops short of it.
ENV NODE_ENV=production
WORKDIR /app

# The `sqlite3` CLI, and only for the backup the README documents (SKG-524). The store itself uses
# `node:sqlite` and needs nothing installed; what needs a binary is `.backup`, which is the one safe
# way to copy a live database — `cp` misses the write-ahead log beside it. About 1.5 MB, and without
# it "the database is the product" comes with a documented command that is not there. Alpine has no
# curl either, which is why the healthcheck below probes with Node.
# `upgrade` before `add`, and it is not belt-and-braces. The base image is rebuilt on its own
# schedule, so it ships whatever Alpine packages it held on that day — measured here as openssl
# 3.5.7-r0 against CVE-2026-14456, which Alpine had already fixed in 3.5.8-r0. The release gate
# scans with `ignore-unfixed`, so a lag like that reddens it for something an upgrade does fix.
# The cost is that the runtime layer is no longer byte-identical between two builds of the same
# commit; the image is pinned by digest at deploy time, which is where that guarantee belongs.
RUN apk upgrade --no-cache && apk add --no-cache sqlite

# The default home for FRUITBACK_SQLITE_PATH, and a mount point for the volume that outlives the
# container. Created here and owned by `node`, because the process does not run as root and a store
# that cannot write its own directory fails at the first note rather than at boot.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# The bundle carries its own dependencies, so the runtime image needs no node_modules at all.
COPY --from=build /repo/apps/worker/dist/server.mjs ./server.mjs

# Never run as root, and never own the files you execute.
USER node

EXPOSE 8080

# Alpine has no curl; Node can probe itself. Readiness is real here — /health answers 503 while a
# required variable is missing, so a bad deploy never gets traffic routed to it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
