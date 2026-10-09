# syntax=docker/dockerfile:1

# The console (FRU-99): static files, and the widget's script beside them.
#
# Build context is the REPO ROOT. In Dokploy: Dockerfile path `apps/console/Dockerfile`, build context
# `.`, port 80. `VITE_FRUITBACK_API` is a build argument: the address of the worker is compiled in.
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
RUN test -n "$VITE_FRUITBACK_API" || (echo "VITE_FRUITBACK_API is required: the console calls that worker" >&2 && exit 1)
RUN pnpm --filter @fruitback/widget build && pnpm --filter @fruitback/console build
RUN node apps/console/csp.mjs apps/console/nginx.conf.template apps/console/build/nginx.conf.template
RUN printf '%s' "$VITE_FRUITBACK_API" > apps/console/build/fruitback-api

FROM nginx:1.29-alpine AS runtime

# The worker's address for the Content-Security-Policy the template writes. It defaults to the address
# the bundle was built with, and `check-api.sh` stops the container when a run sets another one.
ARG VITE_FRUITBACK_API
ENV FRUITBACK_API=${VITE_FRUITBACK_API}
COPY --from=build /repo/apps/console/build/fruitback-api /etc/fruitback-api
COPY apps/console/check-api.sh /docker-entrypoint.d/05-check-api.sh
COPY --from=build /repo/apps/console/build/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/console/build/client /usr/share/nginx/html
# The script a site embeds, from the console's own address until the script has a CDN (FRU-106).
COPY --from=build /repo/packages/widget/dist/fruitback.iife.js /usr/share/nginx/html/fruitback.iife.js

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
