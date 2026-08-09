# 🍓 Fruitback

Visual feedback on a live site, without a backend to host.

A client opens their staging site, clicks the element that bothers them, types a note. It lands in
Linear as a triaged issue — with the CSS selector, the React component and the source file behind
the element. When they come back to the page, their pins are still there, coloured by the Linear
status: 🌱 seeded → 🍏 green → 🍊 ripening → 🍓 ripe.

Pastel-like review, but **Linear is the database** — the dashboard, the triage, the API, the MCP
server and the integrations all come for free.

## Why this shape

Alternatives we looked at and dropped:

- **SitePing** — closest match, but Prisma.
- **Quackback** — no visual layer at all (a text form in a panel), AGPL-3.0, and oversized for the
  need: it brings boards, roadmap and changelog we do not want.
- **Full in-house** — rebuilding auth, dashboard, API, MCP and integrations to reach parity with
  something Linear already does.

So: build **only** the missing piece — the capture and restitution layer — on top of
[react-grab](https://github.com/aidenybai/react-grab) (MIT), and let Linear absorb everything else.
The one thing Linear cannot do is redraw a pin on the page; that part we reconstruct from the anchor
we stored.

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

See [`packages/shared/src/seed.ts`](packages/shared/src/seed.ts) and
[`packages/shared/src/linear.ts`](packages/shared/src/linear.ts).

## Layout

```
packages/shared    the seed contract: schema, Linear mapping, round-trip   ✅
apps/worker        Node service in Docker: write + read path to Linear     ✅
packages/widget    capture + overlay, on top of react-grab                 ⬜
```

## Commands

```bash
pnpm install
pnpm test         # node --test, across packages via Nx
pnpm typecheck
pnpm lint         # oxlint
pnpm format:fix   # oxfmt

pnpm --filter @fruitback/shared test:watch
```

Tests run on Node's own runner (`node:test` + `node:assert/strict`) against the TypeScript sources —
no test framework, no transpiler, no loader in the dependency tree. Same reason relative imports carry
their `.ts` extension: Node's resolver wants it, and it buys `node --test` and `node --watch` for free.

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
