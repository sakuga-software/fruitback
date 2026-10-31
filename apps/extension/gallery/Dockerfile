# syntax=docker/dockerfile:1

# The gallery of the extension (FRU-523): static files, served at gallery.fruitback.com.
#
# Build context is the REPO ROOT. In Dokploy: Dockerfile path `apps/extension/gallery/Dockerfile`,
# build context `.`, port 80.
FROM --platform=$BUILDPLATFORM ghcr.io/pnpm/pnpm:12.15.0-alpine@sha256:f164ca19f7736a0994dae195b81756cd969542a93ef692f5ab466759d06c1da9 AS pnpm

FROM --platform=$BUILDPLATFORM node:26-alpine AS build

WORKDIR /repo
COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/widget/package.json packages/widget/
COPY apps/extension/package.json apps/extension/
# `--ignore-scripts`: the `postinstall` of the extension is `wxt prepare`, which the gallery does not need.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @fruitback/extension...

COPY packages/shared packages/shared
COPY packages/widget packages/widget
COPY apps/extension apps/extension
# `.wxt/tsconfig.json`, which the tsconfig of the extension extends, is written by `wxt prepare`: a
# clone has none, and Vite stops on the missing file.
RUN pnpm --filter @fruitback/extension exec wxt prepare && pnpm --filter @fruitback/extension gallery:build

FROM nginx:1.29-alpine-slim AS runtime

RUN apk upgrade --no-cache

RUN rm -rf /etc/nginx/conf.d /etc/nginx/templates /docker-entrypoint.d /docker-entrypoint.sh
COPY apps/extension/gallery/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/extension/gallery/dist /usr/share/nginx/html

USER 101:101

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1/gallery/" || exit 1

# The entry script of the base image went above, so its ENTRYPOINT goes too.
ENTRYPOINT ["nginx", "-g", "daemon off;"]
