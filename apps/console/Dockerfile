# syntax=docker/dockerfile:1

# The console (FRU-99): static files, and the widget's script beside them.
#
# Build context is the REPO ROOT. One image serves every instance (FRU-222): the address of the
# worker is `FRUITBACK_API`, read when the container starts, and a container without it stops with a
# sentence. See entrypoint.sh.
#
# In Dokploy: Dockerfile path `apps/console/Dockerfile`, build context `.`, port 80. The build
# argument `VITE_FRUITBACK_API` is still taken: it is then the address of a container that is given
# no `FRUITBACK_API`, so the console of the Cloud is built and started as before.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build

WORKDIR /repo
RUN npm install --global pnpm@11.16.0

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/widget/package.json packages/widget/
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile --filter @fruitback/console... --filter @fruitback/widget...

COPY packages/shared packages/shared
COPY packages/widget packages/widget
COPY apps/console apps/console

ARG VITE_FRUITBACK_API
ARG VITE_FRUITBACK_GITHUB
# The widget first: its version holds a hash of its script, and the snippet of the console gives
# `/v/<version>/fruitback.iife.js` (FRU-106, widget-version.ts).
RUN pnpm --filter @fruitback/widget build && \
    VITE_FRUITBACK_WIDGET_VERSION="$(node apps/console/widget-version.ts version packages/widget/dist/fruitback.iife.js packages/widget/package.json)" \
    pnpm --filter @fruitback/console build
RUN node apps/console/csp.mjs apps/console/nginx.conf.template apps/console/build/console.conf.template && \
    node apps/console/widget-version.ts place packages/widget/dist/fruitback.iife.js packages/widget/package.json apps/console/build

# `alpine-slim`: nginx and nothing beside it. The full image carries the image filter, XSLT, GeoIP
# and njs with their libraries, the console uses none, and the release gate scans every one of them.
FROM nginx:1.29-alpine-slim AS runtime

# The packages of the base as they are today: a fix that Alpine has shipped since the base was built
# is a finding of the release gate, and a release that fails publishes nothing.
RUN apk upgrade --no-cache

# The address of a container that is given none: the one of the build, when the build had one. The
# published image is built with none, so it must be given `FRUITBACK_API`.
ARG VITE_FRUITBACK_API
ENV FRUITBACK_API=${VITE_FRUITBACK_API}
# The port nginx listens on inside the container. 80 as before; a runtime that lets no user but
# root open a port below 1024 sets a higher one.
ENV FRUITBACK_CONSOLE_LISTEN=80

# The server of the stock image is not ours, and its entry scripts write under /etc: both go.
RUN rm -rf /etc/nginx/conf.d /etc/nginx/templates /docker-entrypoint.d /docker-entrypoint.sh
COPY apps/console/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/console/build/console.conf.template /etc/fruitback/console.conf.template
COPY apps/console/entrypoint.sh /usr/local/bin/fruitback-console
COPY --from=build /repo/apps/console/build/client /usr/share/nginx/html
# The script a site embeds, at the address of before (`/fruitback.iife.js`, cached five minutes).
# Its versioned copy, cached one year, came with `build/client` above, under `v/<version>/` (FRU-106).
COPY --from=build /repo/packages/widget/dist/fruitback.iife.js /usr/share/nginx/html/fruitback.iife.js

# Not root (FRU-222): the user `nginx` of the base image, by its number so that a runtime can check
# it without reading /etc/passwd. Everything above is owned by root and read-only to it; what the
# container writes is under /tmp.
USER 101:101

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${FRUITBACK_CONSOLE_LISTEN}/" || exit 1

ENTRYPOINT ["fruitback-console"]
CMD ["nginx", "-g", "daemon off;"]
