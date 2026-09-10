# 🍓 Fruitback

Visual feedback on a live site, without a backend to host.

A client opens their staging site, clicks the element that bothers them, types a note. It lands as a
triaged issue — with the CSS selector, the React component and the source file behind the element.
When they come back to the page, their pins are still there, coloured by its status:
🌱 seeded → 🍏 green → 🍊 ripening → 🍓 ripe.

Pastel-like review, but **Fruitback does not store your feedback — a system you already run does.**

**Linear is the default**, and the richest: the dashboard, the triage, the API, the MCP server and
the integrations all come for free. **SQLite is the other end**, and it is what makes self-hosting
mean what it says — one file on a volume, no account anywhere, nothing to sign up for. Choose with
`FRUITBACK_STORE`; see [Where your feedback lives](#where-your-feedback-lives).

## Install

The short version. The long one, with Linear setup, per-client routing and identified reporters, is
in [docs/install.md](docs/install.md).

**The packages are not on npm yet** — the `npm i` line below is the shape of the install, not
something that resolves today.

On a site with no build step, `endpoint` and `client` are the whole configuration — `label` is
optional:

```html
<script
  src="https://cdn.acme.dev/fruitback.iife.js"
  data-fruitback-endpoint="https://feedback.acme.dev"
  data-fruitback-client="acme"
  data-fruitback-label="Leave feedback"
  defer
></script>
```

Or as an import, mounted after your app has rendered the elements it points at:

```ts
import { init } from 'fruitback';

const widget = init({ endpoint: 'https://feedback.acme.dev', clientId: 'acme' });
```

The endpoint is your own worker — the piece that holds the Linear key, because that key cannot ship
in client-side JavaScript. Deploying it is [one container](#deploying-with-dokploy) and three
variables.

## Why this shape

Alternatives we looked at and dropped:

- **SitePing** — closest match, but Prisma.
- **Quackback** — no visual layer at all (a text form in a panel), AGPL-3.0, and oversized for the
  need: it brings boards, roadmap and changelog we do not want.
- **Full in-house** — rebuilding auth, dashboard, API, MCP and integrations to reach parity with
  something Linear already does.

So: build **only** the missing piece — the capture and restitution layer — on top of
[react-grab](https://github.com/aidenybai/react-grab) (MIT), and let the issue tracker absorb
everything else. The one thing it cannot do is redraw a pin on the page; that part we reconstruct
from the anchor we stored.

## Where your feedback lives

`FRUITBACK_STORE` picks the connector. It defaults to `linear`, so a deployment that sets nothing
keeps the behaviour it has. Each connector reads only its own variables — a worker on SQLite is never
asked for a Linear key, and an unknown name is refused at boot rather than quietly defaulted.

| `FRUITBACK_STORE` | Needs | Good for |
| --- | --- | --- |
| `linear` *(default)* | `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | A team already triaging in Linear. Everything comes for free: dashboard, API, MCP, integrations. |
| `sqlite` | `FRUITBACK_SQLITE_PATH` | Self-hosting with **no third party at all**. One file on a volume. |
| `memory` | nothing | The dev loop only. Refused under `NODE_ENV=production`. |

### SQLite

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

## Architecture

```
widget (client site)            worker (proxy)              Linear
──────────────────              ──────────────              ──────
react-grab picker      ──POST──▶ create issue      ──────▶  issue + labels
comment popover                  (server-side token)        description = seed
pin overlay            ◀──GET─── query by label+URL ◀─────  status, comments
```

- **widget** — `@fruitback/widget`, an embeddable script (Shadow DOM, so the client's CSS is never
  touched). Picks the element via `react-grab/primitives`, captures the anchor, and later re-plants
  the pins it reads back.
- **worker** — a small Node process in a container (Docker on a VPS, deployed by Dokploy from a
  GitHub push). Its only reason to exist: the Linear token cannot live in client-side JS on a public
  site. It also decides attribution (anonymous vs signed in).
- **shared** — `@fruitback/shared`, the _seed_ contract. Both ends depend on it.

No database, no dashboard, no session store.

## The seed

A **seed** is one piece of feedback planted on an element. It is stored as a JSON block inside the
Linear issue description, under a human-readable summary.

Two decisions worth knowing:

**Why the description and not a Linear custom field** — it is portable (no workspace admin setup,
survives an export) and Linear can filter on it server-side with
`description: { contains: <canonical url> }`, which is how "the seeds of this page" is fetched
without walking every issue. The cost is that a human can corrupt the block, so the parser is
deliberately tolerant: it accepts any fenced block, with or without a language tag, backticks or
tildes, CRLF, even an unterminated fence, and finds ours by its `kind` field.

**Why the anchor is redundant** — a selector breaks the moment the site is redeployed. Every seed
therefore carries several independent ways to find the element again (`selector`, test id, text
excerpt, `domPath`, and bounds as a share of the document). When none of them resolve, the pin
becomes an _orphan_ — listed aside rather than dropped on the wrong element. That degradation is
what separates a demo from a tool people keep using.

Everything the widget draws lives in one Shadow root, mounted at the document origin. That is what
makes "no style conflicts" true in both directions on a site whose CSS nobody has read — and the
selection engine underneath it is `react-grab/primitives`, which hit-tests through shadow roots and
iframes and reads the component and source file straight off the React fiber.

Coming back, the pin has to find its element again. The claims are tried in order — selector, test
id, text, structural path, position — and the answer carries **how it was found**: the first three
identify an element, the last two only locate a spot. A pin placed by position is drawn dashed and
says so, because a neighbour that slid into a vacated slot has the same tag, the same text and the
same box, and a pin that looks certain is believed.

Picking the selector is the part that decides whether any of this survives a redeploy: a test id or
an author-written id is kept, a `useId` `:r7:` and a CSS-modules class are refused, and an element
that repeats is anchored under the nearest ancestor that *is* identifiable rather than pathed from
`<html>`.

See [`packages/shared/src/seed.ts`](packages/shared/src/seed.ts),
[`packages/shared/src/linear.ts`](packages/shared/src/linear.ts) and
[`packages/widget/src/selector.ts`](packages/widget/src/selector.ts).

## Layout

```
packages/shared    the seed contract: schema, Linear mapping, round-trip   ✅
apps/worker        Node service in Docker: write + read path to Linear     ✅
packages/widget    capture + overlay + Shadow DOM host + popover          ✅
apps/playground    hostile demo page + dev loop, on a fake Linear          ✅  dev only
```

## Commands

```bash
pnpm install
pnpm dev          # playground on :5177 + worker on :8788, no Linear key needed
pnpm test         # node --test, across packages via Nx
pnpm e2e          # playwright, starts both servers itself
pnpm typecheck
pnpm lint         # oxlint
pnpm format:fix   # oxfmt

pnpm --filter @fruitback/shared test:watch
```

Tests run on Node's own runner (`node:test` + `node:assert/strict`) against the TypeScript sources —
no test framework, no transpiler, no loader in the dependency tree. Same reason relative imports carry
their `.ts` extension: Node's resolver wants it, and it buys `node --test` and `node --watch` for free.

On top of that sits a small Playwright suite, for the two things a DOM emulator cannot vouch for and
that this product rests on: a real selector engine and real layout. `pnpm dev` opens the same page by
hand — a deliberately hostile fake client site, with a **Redéployer** button that rehashes classes and
shuffles the markup so re-anchoring can be watched rather than argued about. Both run against an
**in-memory Linear**, so neither needs an API key nor touches a workspace.

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
| `POST /feedback`                 | plants a seed: creates the issue, returns `identifier` + `url`            |
| `GET /feedback?url=…[&client=…]` | the seeds of that page: anchor, note, Linear state, stage                 |
| `OPTIONS /feedback`              | CORS preflight, never touches Linear                                      |
| `GET /health`                    | `200` when it can serve, `503` naming the missing variables when it can't |

Labels are created on demand, so a new client site needs no manual Linear setup. A label that cannot
be created is dropped and the feedback still goes through — losing a label is a triage annoyance,
losing the client's note is a bug.

The read path is one Linear query, narrowed server-side by the `fruitback` label, the per-client
label and `description contains <canonical url>` — the workspace can hold any number of issues
without the worker walking them. `contains` being a substring match, the seed's own
`page.url` is re-checked exactly, or `/pricing` would return the pins of `/pricing?tab=annual`.
Answers are cached in-process for 15 s: the same page opened by a room full of reviewers costs one
call against the Linear quota, and a failed call is never cached.

### Running the published image

Self-hosting does not need this repository. Every push to `main` publishes
`ghcr.io/sakuga-software/fruitback-worker`, so the install is a `docker run` rather than a clone, a
pnpm install and a full compilation — which on a small VPS fails for lack of memory about as often as
it succeeds.

```bash
docker run -d --name fruitback -p 8080:8080 \
  -e ALLOWED_ORIGINS=https://staging.example.com \
  -e FRUITBACK_STORE=sqlite \
  -e FRUITBACK_SQLITE_PATH=/data/fruitback.db \
  -v fruitback-data:/data \
  ghcr.io/sakuga-software/fruitback-worker:edge
```

**`edge` and not `latest`, for now.** The versioned tags come from a `v*` git tag, and this repo has
pushed none yet — so `latest`, `1.4.2` and `1.4` do not resolve, and asking for one gets you
`manifest unknown` rather than an image. `edge` is every merge to `main`, which today is the only
thing published. Pin `sha-<commit>` if you want that not to move under you.

**`linux/amd64` and `linux/arm64` both**, because a Raspberry Pi or an ARM VPS is ordinary
self-hosting, and an amd64-only image excludes them with an error that reads like a broken download.
Docker picks the right one from the manifest list; there is no per-architecture tag to choose.

| Tag | Moves | Exists today | Use it for |
| --- | --- | --- | --- |
| `1.4.2`, `1.4` | Never / on a patch | Not yet | Production. This is what you can pin and roll back to. |
| `latest` | On a `v*` release tag only | Not yet | A deployment that follows releases and nothing else. |
| `edge` | Every push to `main` | Yes | Running what is not released yet — which is all there is so far. |
| `sha-<commit>` | Never | Yes | Naming one exact build, in an incident or a bisect. |

`latest` deliberately does **not** follow `main`: a `latest` that moved on every merge would take
away the one thing a tag is for.

The image runs as `node` rather than root, carries no `node_modules` — the build stage bundles
everything into one file — and declares a `HEALTHCHECK` against `/health`, which answers `503` while
a required variable is missing. Every published build ships a provenance attestation and an SBOM:

```bash
gh attestation verify oci://ghcr.io/sakuga-software/fruitback-worker:edge --owner sakuga-software
docker buildx imagetools inspect ghcr.io/sakuga-software/fruitback-worker:edge --format '{{json .SBOM}}'
```

Nothing is published before it has been booted and scanned. The release workflow builds one
architecture first, starts it, waits for `/health`, asserts the image still **refuses**
`FRUITBACK_STORE=memory` — `NODE_ENV=production` is what refuses it, and a mis-staged build would
drop that with no other symptom — and runs Trivy at `CRITICAL,HIGH`. Only then does it build both
architectures and push.

### Deploying with Dokploy

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

## Roadmap

Tracked in Linear on the [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6)
project (team SKG). Critical path: **SKG-491 → SKG-497 → SKG-500** — schema, then write, then
read-back.

| Milestone            | Scope                                                     |
| -------------------- | --------------------------------------------------------- |
| 🌱 M1 Foundation     | monorepo, seed schema + Linear mapping                    |
| 🍓 M2 Capture        | react-grab in Shadow DOM, popover, anchor, screenshot     |
| 🍊 M3 Write → Linear | worker, issue creation, anonymous/identified attribution  |
| 🥝 M4 Read & overlay | query by label + URL, re-anchoring, orphan pins, comments |
| 🫐 M5 Config in-app  | settings panel, multi-client mapping                      |
| 🥥 M6 Packaging      | npm package, install snippet, optional Linear webhook     |

## Licence

Two licences, split where the client/server boundary is (SKG-515).

| | |
| --- | --- |
| `packages/widget`, `packages/shared`, `packages/fruitback` | **MIT** |
| `apps/worker` | **AGPL-3.0-only** |

The three published packages are **MIT** because they are compiled into someone else's site. A
copyleft licence on code that ships inside a client's own bundle is one nobody can adopt, and the
widget is worth nothing unadopted.

The worker is **AGPL-3.0-only**. It is the server — the only place copyleft actually bites — so
anyone who hosts a modified version publishes their modifications. Copyright (C) 2026 Sakuga
Software; the full text is in [`apps/worker/LICENSE`](apps/worker/LICENSE).

`apps/playground` is not published and not deployed; it inherits the repository's MIT licence.

### Bundled dependencies

`@fruitback/widget` compiles `react-grab` and `zod` **into** its `dist` rather than asking a client
site to install them. Both are MIT, and MIT requires their notices to travel with the code, so the
tarball ships [`THIRD-PARTY-NOTICES.md`](packages/widget/THIRD-PARTY-NOTICES.md) — checked by the
suite, not by hand.

`@fruitback/shared` is compiled rather than bundled and keeps `zod` as an ordinary dependency, so its
consumers get that notice from npm.
