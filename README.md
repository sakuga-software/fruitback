# 🍓 Fruitback

[![CI](https://github.com/sakuga-software/fruitback/actions/workflows/ci.yml/badge.svg)](https://github.com/sakuga-software/fruitback/actions/workflows/ci.yml)
[![Licence: MIT + AGPL-3.0](https://img.shields.io/badge/licence-MIT%20%2B%20AGPL--3.0-blue)](#licence)

**Visual feedback on a live site, without a backend to host.**

A client opens their staging site, clicks the element that bothers them, types a note. It lands as a
triaged issue carrying the CSS selector, the React component and the source file behind that element.
When they come back to the page, their pins are still there, coloured by the issue's status:
🌱 seeded → 🍏 green → 🍊 ripening → 🍓 ripe.

![A pin anchored on a button of a live page, coloured by its issue's status](docs/assets/pin-on-a-live-page.png)

**Fruitback runs no service that holds your feedback.** It lands in the tracker your team already
uses — or, with `FRUITBACK_STORE=sqlite`, in a file on a volume you own. No database of ours, no
dashboard of ours, no account to create anywhere.

## Install

Two lines on a site with no build step. `client` is the name this site reports under, and `endpoint`
is **your own worker** — the piece that holds the tracker's API key, because that key cannot ship in
client-side JavaScript. It is one container: [docs/self-hosting.md](docs/self-hosting.md).

```html
<script
  src="https://cdn.acme.dev/fruitback.iife.js"
  data-fruitback-endpoint="https://feedback.acme.dev"
  data-fruitback-client="acme"
  defer
></script>
```

Or as an import, mounted after your app has rendered the elements it points at:

```ts
import { init } from 'fruitback';

const widget = init({ endpoint: 'https://feedback.acme.dev', clientId: 'acme' });
```

> **The packages are not on npm yet.** The lines above are the shape of the install, not something
> that resolves today. The worker image *is* published — see [docs/self-hosting.md](docs/self-hosting.md).

The full walk-through — Linear setup, per-client routing, identified reporters — is in
[docs/install.md](docs/install.md).

<img src="docs/assets/writing-a-note.png" alt="The note popover, anchored to the element it is about" width="330">

## Two ways to run it, and a third being built

The first question a reader has is whether their reviewers need the site to ship anything. Both
answers exist.

| | **Public** | **Private** | **Team** |
| --- | --- | --- | --- |
| The site embeds | the widget | **nothing** | the widget, dormant |
| Delivered as | `<script>` tag or npm | a browser extension | `<script>` tag or npm |
| Published | **not yet** — build it from this repo | **not yet** — load it unpacked | — |
| Who sees the pins | every visitor | the reviewer who installed it | reviewers who are signed in |
| Good for | a public "report a problem" | reviewing a client's site, invisibly | a team reviewing its own staging |
| Built | **yes** | **yes**, MV3 on Chromium and Firefox | planned (SKG-596) |

The extension asks for **no host permission at install**: its content scripts are registered at
runtime, per origin, when somebody switches that site on.

## Where your feedback lives

`FRUITBACK_STORE` picks the connector. It defaults to `linear`, so a deployment that sets nothing
keeps the behaviour it has. Each connector reads only its own variables — a worker on SQLite is never
asked for a Linear key — and an unknown name is refused at boot rather than quietly defaulted.

| `FRUITBACK_STORE` | Needs | Runs on | Good for |
| --- | --- | --- | --- |
| `linear` *(default)* | `LINEAR_API_KEY`, `LINEAR_TEAM_ID` | anywhere the worker runs | A team already triaging in Linear. Dashboard, API, MCP and integrations come for free. |
| `sqlite` | `FRUITBACK_SQLITE_PATH` | **a persistent filesystem only** | Self-hosting with no third party at all. One file on a volume. |
| `memory` | nothing | the dev loop | Refused under `NODE_ENV=production`. |

SQLite is one file through `node:sqlite` — no dependency, no native module, and the schema migrates
itself on open, so a self-hoster starts one container rather than two. What it gives up is the
dashboard: with no tracker behind it, the pins on the page are the interface. The compose snippet,
the one-line backup and what else you trade are in
[docs/self-hosting.md](docs/self-hosting.md#storing-the-seeds-in-sqlite).

A GitHub Issues connector is planned (SKG-525). The interface it plugs into is
[`apps/worker/src/store.ts`](apps/worker/src/store.ts).

## Security, and what is open by default

Fruitback puts a widget in somebody else's page and a worker in front of somebody's issue tracker.
**[SECURITY.md](SECURITY.md) says where those boundaries are**, and it is worth reading before you
deploy rather than after. Two things surprise people most often:

- **`GET /feedback` answers anyone who can build the URL**, unless you set
  `FRUITBACK_READ=authenticated`. Every note, its reporter's name and address, and the team's replies
  are readable by any visitor of the client's site — and by `curl`. The default stays open so an
  upgrade never blanks a working deployment; the boot log names every client it applies to.
- **`clientId` is asserted by the browser, never authenticated.** `origins` makes the claim checkable
  against the browser's own header — the trust level CORS gives, and no more.

It also says how to report a vulnerability.

## Documentation

| | |
| --- | --- |
| [docs/install.md](docs/install.md) | Putting the widget on a site, end to end |
| [docs/self-hosting.md](docs/self-hosting.md) | Running the worker: the image, the tags, a deployment |
| [docs/architecture.md](docs/architecture.md) | Why this shape, the seed contract, the layout, the commands |
| [docs/decisions/](docs/decisions/) | Per-subject histories: what was measured, what failed first |
| [SECURITY.md](SECURITY.md) | The threat model, stated rather than implied |
| [CLAUDE.md](CLAUDE.md) | The conventions and invariants, for anyone — human or agent — writing code here |

Work is tracked in Linear on the
[Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team SKG).

## Licence

Two licences, split where the client/server boundary is (SKG-515).

| | |
| --- | --- |
| `packages/widget`, `packages/shared`, `packages/fruitback` | **MIT** |
| `apps/worker` | **AGPL-3.0-only** |

The three client-side packages are **MIT** because they are compiled into someone else's site: a
copyleft licence on code that ships inside a client's own bundle is one nobody can adopt, and the
widget is worth nothing unadopted. (They are the three meant for npm — not three that are on it; see
the install note above.) The worker is **AGPL-3.0-only** — it is the server, the only place
copyleft actually bites, so anyone who hosts a modified version publishes their modifications.
Copyright (C) 2026 Sakuga Software; the full text is in
[`apps/worker/LICENSE`](apps/worker/LICENSE).

`@fruitback/widget` compiles `react-grab` and `zod` **into** its `dist` rather than asking a client
site to install them. Both are MIT, and MIT requires their notices to travel with the code, so the
tarball ships [`THIRD-PARTY-NOTICES.md`](packages/widget/THIRD-PARTY-NOTICES.md) — checked by the
suite, not by hand. `apps/playground` is not published and not deployed; it inherits the repository's
MIT licence.
