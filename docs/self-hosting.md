# Running the worker yourself

The operational half of the old README (SKG-519): the worker, the published image, and one way to
deploy it. [install.md](install.md) is the other side of the same job — putting the widget on a site
and pointing it here.

**This is moved material, not yet a guide.** SKG-543 owns turning it into one: prerequisites first,
every environment variable in one reference table, and a reverse-proxy section. What is below is
accurate and incomplete in that shape.

## The worker

A plain Node HTTP process — `node:http` adapted onto a web-standard handler, no framework. It runs as
a container: Dokploy builds the image from a GitHub push and puts Traefik in front of it on the VPS.

```bash
cp .env.example .env                            # then fill LINEAR_API_KEY
pnpm --filter @fruitback/worker dev             # node --watch on the TypeScript, no container
pnpm --filter @fruitback/worker build           # esbuild → dist/server.mjs, one file
docker compose up --build worker                # the real image, locally
```

| Route                            | Status                                                                    |
| -------------------------------- | ------------------------------------------------------------------------- |
| `POST /feedback`                 | plants a seed in the configured store, returns `identifier` + `url`      |
| `GET /feedback?url=…[&client=…]` | the seeds of that page: anchor, note, state, stage                        |
| `OPTIONS /feedback`              | CORS preflight, never reaches the store                                   |
| `GET /health`                    | `200` when it can serve, `503` naming the missing variables when it can't |

The three below exist only when `FRUITBACK_SESSION_PATH` is set, and answer `404` otherwise — a
worker without the extension does not advertise that they are there. They are the browser
extension's session (SKG-535), and they are **exempt from `ALLOWED_ORIGINS`**: an extension's origin
carries an id that differs between an unpacked build and a store build, so an operator cannot put it
on a list. The rate limiter is what protects them, which is why it runs above the path dispatch.

| Route                            | Status                                                                    |
| -------------------------------- | ------------------------------------------------------------------------- |
| `POST /session/pair`             | spends a pairing code, opens a session                                    |
| `POST /session/refresh`          | a refresh token for a fresh access token                                  |
| `POST /session/revoke`           | ends the session; `204` whether or not there was one to end               |

A pairing code is minted by a **command on the container**, never over HTTP:
`node server.mjs pair --subject … --name …`. Vouching for a person is not something this worker has
to defend as a network surface.

**The three paragraphs below describe the `linear` connector**, which is the default. A worker on
another store does the same job by its own means — see `apps/worker/src/store.ts`, where `findForPage`
states the intention and never the method.

Labels are created on demand, so a new client site needs no manual Linear setup. A label that cannot
be created is dropped and the feedback still goes through — losing a label is a triage annoyance,
losing the client's note is a bug.

The read path is one Linear query, narrowed server-side by the `fruitback` label, the per-client
label and `description contains <canonical url>` — the workspace can hold any number of issues
without the worker walking them. `contains` being a substring match, the seed's own
`page.url` is re-checked exactly, or `/pricing` would return the pins of `/pricing?tab=annual`.
Answers are cached for 15 s: the same page opened by a room full of reviewers costs one call against
the Linear quota, and a failed call is never cached. Where that cache lives — and the rate limiter
with it — is `FRUITBACK_KV`, which matters as soon as there are two containers.

## Storing the seeds in SQLite

One file, `node:sqlite`, no dependency and no native module to compile. The schema is created on
first open and migrated in place, so there is no separate command to run — a self-hoster starts one
container, not two.

```yaml
# docker-compose.yml
services:
  worker:
    environment:
      FRUITBACK_STORE: sqlite
      FRUITBACK_SQLITE_PATH: /data/fruitback.db
    volumes:
      - fruitback-data:/data
```

**Back it up with one line**, and do it against the running container rather than copying the file —
a live SQLite database has a write-ahead log beside it, and `cp` catches neither consistently:

```bash
docker compose exec worker sqlite3 /data/fruitback.db ".backup '/data/backup.db'"
```

What you give up: **SQLite needs a persistent filesystem**, so it cannot run on a serverless runtime.
That is the trade, not an oversight. And with no issue tracker behind it there is no dashboard and no
triage UI — the pins on the page are the interface, and a note's thread lives in the `comments`
table. A store with no web interface reports no link, and the widget renders none rather than one
that leads back to the page you are already on.

## Running more than one replica

`FRUITBACK_KV` says where the rate limiter and the read cache keep their state. It is `memory` by
default, which means **inside each container**. One container is the whole story; two are two rate
limits, so `RATE_LIMIT_PER_MINUTE=20` becomes 40 with nothing said anywhere, and a cold page costs one
provider call per replica.

Point them at one Redis and they share both:

```yaml
services:
  worker:
    environment:
      FRUITBACK_KV: redis
      FRUITBACK_REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379/0
  redis:
    image: redis:7-alpine
    command: ['redis-server', '--requirepass', '${REDIS_PASSWORD}', '--save', '']
    restart: unless-stopped
```

`--save ''` on purpose: nothing here outlives its expiry, so there is nothing to write to disk. Any
Redis-speaking server does — Valkey included. `rediss://` for TLS, and the password sits in a URL, so
percent-encode a `@`, a `:`, a `/` or a `?` in it.

**Treat it as the worker's own memory.** Anyone who can write to that Redis can plant pins on a page
and clear a rate limit, and a cached answer holds notes and their authors for 15 seconds. Private
network, password, its own database.

A Redis that stops answering refuses every metered call with `503`, which is `/feedback` and
`/session/*`. `/health` never touches it, so the replicas stay in the load balancer and recover on
their own when the Redis comes back.

## Running the published image

Self-hosting does not need this repository. Every push to `main` publishes
`ghcr.io/sakuga-software/fruitback-worker`, so the install is a `docker run` rather than a clone, a
pnpm install and a full compilation — which on a small VPS fails for lack of memory about as often as
it succeeds.

> **While this repository is private, so is the package.** GHCR gives a new package the visibility of
> the repository it came from, so an unauthenticated `docker pull` answers `denied` until an owner
> makes the package public — *Packages → `fruitback-worker` → Package settings → Change visibility*.
> Until then, `docker login ghcr.io` with a token carrying `read:packages` is what works.

```bash
docker run -d --name fruitback -p 8080:8080 \
  -e ALLOWED_ORIGINS=https://staging.example.com \
  -e FRUITBACK_STORE=sqlite \
  -e FRUITBACK_SQLITE_PATH=/data/fruitback.db \
  -v fruitback-data:/data \
  ghcr.io/sakuga-software/fruitback-worker:edge
```

**`edge` and not `latest`, until the first release.** The versioned tags come from a `v*` git tag, so
before one is pushed `latest`, `1.4.2` and `1.4` resolve to nothing and asking for one gets you
`manifest unknown` rather than an image. `edge` and `sha-<commit>` are what exist from the first
merge onwards; the rest arrive with the first release and are the better choice from then on.

**`linux/amd64` and `linux/arm64` both**, because a Raspberry Pi or an ARM VPS is ordinary
self-hosting, and an amd64-only image excludes them with an error that reads like a broken download.
Docker picks the right one from the manifest list; there is no per-architecture tag to choose.

| Tag | Moves | Published by | Use it for |
| --- | --- | --- | --- |
| `1.4.2` | Only if that release is rebuilt | A `v1.4.2` git tag | Production. This is the one to pin and to roll back to. |
| `1.4` | On every patch in that minor | Any `v1.4.x` git tag | Taking patches without reading a changelog. It moves — do not call it a pin. |
| `latest` | On every release | Any `v*` git tag | A deployment that follows releases and nothing else. |
| `edge` | Every push to `main` | A merge to `main` | Running what is not released yet. |
| `sha-<commit>` | Only if that commit is rebuilt | Every publish | Naming one commit's build, in an incident or a bisect. |
| `@sha256:…` | **Never** | Every publish | The only immutable reference. Pin this when it must not move. |

`latest` deliberately does **not** follow `main`: a `latest` that moved on every merge would take
away the one thing a tag is for.

**No tag is immutable, `sha-<commit>` included** — raised in review, and it is worth being exact
about. Re-running the workflow on the same commit, or publishing a `v*` tag that points at a commit
already on `main`, builds again and republishes every tag it computes. The image is identical in
substance but not in bytes: `org.opencontainers.image.created` moves, so the digest does. A tag names
a commit; only a digest names a build.

```bash
docker pull ghcr.io/sakuga-software/fruitback-worker@sha256:<digest>   # cannot move under you
```

The image runs as `node` rather than root, carries no `node_modules` — the build stage bundles
everything into one file — and declares a `HEALTHCHECK` against `/health`, which answers `503` while
a required variable is missing. Every published build ships a provenance attestation and an SBOM:

```bash
gh attestation verify oci://ghcr.io/sakuga-software/fruitback-worker:edge --owner sakuga-software
docker buildx imagetools inspect ghcr.io/sakuga-software/fruitback-worker:edge --format '{{json .SBOM}}'
```

**Nothing is published before it has been booted and scanned — on every architecture, not one.** The
release workflow builds each platform separately, starts it, waits for `/health`, asserts the image
still **refuses** `FRUITBACK_STORE=memory` — `NODE_ENV=production` is what refuses it, and a
mis-staged build would drop that with no other symptom — and runs Trivy at `CRITICAL,HIGH`. Both must
pass before either is pushed. Checking only the runner's own architecture would have let an
arm64-only failure through every gate, on the architecture this is here to serve.

## Deploying with Dokploy

Create an **Application** on the fruitback repo with:

| Setting         | Value                                                            |
| --------------- | ---------------------------------------------------------------- |
| Build type      | Dockerfile                                                       |
| Dockerfile path | `apps/worker/Dockerfile`                                         |
| Build context   | `.` — the repo root, it needs the lockfile and `packages/shared` |
| Port            | `8080`                                                           |

Then set the environment (`.env.example` lists all of it). `LINEAR_API_KEY` is a secret: it belongs
in Dokploy's environment, never in the image or the repo. The image runs as `node`, not root, and
carries no `node_modules` — the build stage bundles everything into a single file.

`FRUITBACK_STORE` chooses where the seeds live, and `linear` is the default — so a deployment that
sets nothing keeps the behaviour it has. Each store reads only its own variables, which is why a
worker on another store is never asked for a Linear key; an unknown name is refused at boot rather
than quietly defaulted.

`/health` is a real readiness probe: it answers `503` while a required variable is missing, so a
misconfigured deploy never gets traffic routed to it, and `curl /health` tells you exactly which
variable to set. The process also drains in-flight requests on `SIGTERM` before exiting.

**`TRUSTED_PROXY_HOPS` deserves a second of attention.** It is how many reverse proxies sit in front
of the container — `1` for Traefik alone. `X-Forwarded-For` is appended to by each proxy, so entries
on the left came from the caller and are forgeable; only the rightmost ones were written by
infrastructure you control. Set this too low and the rate-limit key becomes caller-controlled, which
makes the limit trivially bypassable.
