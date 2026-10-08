# syntax=docker/dockerfile:1

# The public demonstration (FRU-79): the playground, served by Vite in development mode.
#
# Build context is the REPO ROOT, like the worker's. In Dokploy: Dockerfile path
# `apps/playground/Dockerfile`, build context `.`, port 5177.
#
# **Development mode on purpose.** A note carries the React component and the source file of the
# element, and both come from metadata that only a development build of React keeps. Measured on a
# production build of this app: the component is `bound qi` and the file is a chunk of the bundle.
# A demonstration that does not show the component and the file does not show the product.
#
# WARNING: this image runs a development server. It must hold nothing but this public repository:
# no secret in its environment, and no volume. Do not use it as a model for a real site.
FROM node:26-alpine

RUN npm install --global pnpm@11.16.0

# Vite writes its cache and React Router its typegen under the app, so `node` owns the tree. The
# files are copied as `node`: a `chown` after the copy would store every file a second time.
RUN mkdir /repo && chown node:node /repo
WORKDIR /repo
USER node

# Manifests first: this layer only busts when a dependency changes.
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node packages/widget/package.json packages/widget/
COPY --chown=node:node apps/playground/package.json apps/playground/
RUN pnpm install --frozen-lockfile --filter @fruitback/playground...

COPY --chown=node:node packages/shared packages/shared
COPY --chown=node:node packages/widget packages/widget
COPY --chown=node:node apps/playground apps/playground

EXPOSE 5177

# Vite answers before it has optimized its dependencies, so the probe asks for the page itself.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5177/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `--host` listens on every interface of the container. The port is the one `vite.config.ts` fixes.
CMD ["pnpm", "--filter", "@fruitback/playground", "exec", "react-router", "dev", "--host", "0.0.0.0"]
