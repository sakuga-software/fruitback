# The project, and the layout

Each section opens with **the rules, in short**: what [CLAUDE.md](../../CLAUDE.md) said until it was
cut down to what no lint rule and no test can hold, and they are the versions to trust. What follows
them is **what `CLAUDE.md` used to say** before FRU-59 condensed both sections — that older Layout
predates `packages/fruitback` and the settings panel, and names `packages/widget`'s parts by the
tickets that built them.

The older text is kept because each section carries a history the condensed version drops: what the
project claimed about itself before FRU-31 gave the worker a store of its own, and which ticket built
which part of the widget.

## Project

### The rules, in short

**It is three products sharing one core, and they differ on what the site ships** (FRU-46):
**public**, where the site embeds the widget and every visitor can leave a note; **private**, where
the site embeds nothing and the extension mounts the widget for one reviewer; **team**, where the
site embeds a dormant widget the extension wakes and relays for. [docs/modes.md](../modes.md) is
the page that names them for a reader, and the one thing to carry from it here: **who may read is
`read`, and the mode decides who can satisfy it.** Public mode can run `authenticated` when the host
mints its own tokens (`init({ identityToken })`, sent on reads since FRU-40); team mode is the only
one where the **reviewer** supplies the credential and the page never holds it; **private mode can
supply neither**, so it changes who is _shown_ the feedback and never who may _fetch_ it. Writing
"only team mode protects a read" is the overclaim in the other direction, and it shipped in
`CLAUDE.md` for one review round. The three-mode split is a
naming decision, not a third code path: what differs lives in the assembly layer, and
`packages/widget` does not know which one it is in.

**Status, threads, assignees and history belong to the store**, never to a second model kept in step
with it. Every store the worker speaks to is one somebody already runs: the PostgreSQL of the
instance is the default (FRU-225), Linear the richest, and `FRUITBACK_STORE=github` is for a team
whose issues are already on GitHub. Fruitback does not reinvent issue tracking, and since FRU-31 it
no longer requires somebody else's account either. See [docs/architecture.md](../architecture.md) for
the alternatives that were dropped.

**Every instance has PostgreSQL and an administrator account; a visitor needs no account**
(decided on 2026-10-13, FRU-225, FRU-227). See
[PostgreSQL and an administrator, on every instance](#postgresql-and-an-administrator-on-every-instance).

**Fruitback Cloud is one such deployment**, and `apps/worker/cloud/README.md` is its runbook
(FRU-106, FRU-128): where it runs, what is backed up, and how to restore. The host archives every
Docker volume each night, and `snapshot-pg.sh` writes a dump of the database into the volume of the
worker just before, because the files of a database that runs are not a copy to trust. The two secrets of the worker
are in no backup.

### The reasons, and the history

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes an issue carrying the CSS selector, the React component and the source file.
Coming back to the page, they see their pins again, coloured by that issue's status.

**Fruitback does not reinvent issue tracking — but it no longer requires somebody else's account.**
That is a change, and FRU-31 made it deliberately. This file used to say _there is no Fruitback
backend, Linear is the database_, and until the SQLite connector that was exactly true. It is not any
more: `FRUITBACK_STORE=sqlite` puts the notes in a file on a volume, and a self-hoster who wants no
third party has a door.

What has **not** changed is the instinct behind that sentence. Status, threads, assignees and history
still belong to the store, never to a second model kept in step with it — and every store the worker
speaks to is one somebody already runs. Linear stays the default and the richest of them: the
dashboard, the triage, the API, the MCP server and the integrations all come for free. See
[README.md](../../README.md) for the reasoning and the alternatives that were dropped.

Deployment is **Docker on a VPS, driven by Dokploy from GitHub** — no Cloudflare, no serverless, no
managed platform primitives. When something needs infrastructure, reach for what a single container
behind Traefik can do.

## PostgreSQL and an administrator, on every instance

Decision of Mathieu, 2026-10-13, in his words:

> « il faut toujours un postgres quoiqu'il arrive pour faire tourner fruitback même en self-hosted, sur
> une nouvelle db ou sur une db existante dans un schema dédié / et on peut créer un compte quoiqu'il
> arrive aussi pour la partie admin, par contre pas forcément besoin de compte pour laisser des notes
> côté user / et au pire on peut fournir un driver pour permettre de stocker les mêmes infos sur
> d'autres systèmes de données (adapter) »

### The rules, in short

- **A worker needs PostgreSQL to start**, a database of its own or a schema of one that exists
  (`FRUITBACK_DATABASE_SCHEMA`, FRU-219). Nothing falls back to a file. The code that enforces it is
  FRU-225; [worker.md](worker.md#postgresql-is-required-fru-225) has its rules.
- **Every instance has an administrator account**, made from the link the worker writes in its log
  for `FRUITBACK_FIRST_ADMIN` (FRU-221), so an instance with no e-mail and no provider still has one.
  **A visitor who leaves a note needs no account** (FRU-224).
- **Another data system is an adapter to write later, if somebody needs one**: « au pire on peut
  fournir un driver ». None exists, and nothing in the worker waits for one.
- **The self-hosting guide starts from an empty folder and ends on a pin a visitor planted**
  (FRU-227): the compose file, five lines of `.env`, the link of the first administrator, a site in
  the console, the script tag, and the note. Seven steps, measured on the images; FRU-107 counted
  seven for the path of before, which ran one container with no account.

### What it replaces

- **The first default of FRU-143**: a `postgres` service behind a profile, which the default path did
  not start, so that « the self-hoster with no accounts keeps one container ». The compose file starts
  the worker, its PostgreSQL and the console together since FRU-225.
- **The « starting position » of the Self-hosted simplified project** (FRU-107, 2026-10-08): « the
  code typed by the admin stays the default way, and nothing becomes mandatory that is not today ».
  PostgreSQL and an administrator account are mandatory now. It is option B of the framing of
  2026-10-12; the framing recommended A, two tiers with a one-container tier kept, and A was not
  taken.
- **`FRUITBACK_STORE=sqlite` as the door for a self-hoster who wants no third party** (FRU-31). The
  door is the database of the instance. A file of before is copied there by `migrate-to-postgres`, and
  the code of the file store went with FRU-226.

### The reasons, and the history

The cost is stated rather than hidden: an instance is three containers where it was one, and a person
has to sign in once before a site exists. What it buys is one path to document and to keep green,
where option A would have kept two; one place for every note, site, account and session; and a
console for every self-hoster, which the Cloud already had. CI's `image` job runs that path from an
empty directory on every pull request, and the guide was replayed by hand on the images for FRU-227.

## Layout

### The rules, in short

- `packages/widget` (`@fruitback/widget`) — the browser half, and the whole of it: capture
  (`captureNote`), the overlay (`resolveAnchor` + `createOverlay`), the Shadow DOM host
  (`createCaptureHost`), the note popover (`createComposer`) and the settings panel.
- `packages/fruitback` — the front door a client installs. It re-exports the two above and defines
  nothing.
- `packages/element` (`@fruitback/element`) and `packages/react` (`@fruitback/react`) — the widget as
  a custom element and as a React component. Each wraps `init` and `destroy`.
- `apps/playground` (`@fruitback/playground`) — the dev loop: a deliberately hostile fake client site
  with the widget mounted on it, built as a React Router 8 + Vite app with HeroUI because the
  widget's clients are React apps. Not shipped. It is deployed once, as the public demonstration
  (FRU-79), and nowhere else.

### The reasons, and the history

- `packages/shared` (`@fruitback/shared`) — the note contract. Browser- and server-safe: no Node API,
  no DOM API beyond `URL`. Also exports `@fruitback/shared/note.fixture`, so every package tests
  against the same note instead of keeping a drifting copy.
- `apps/worker` (`@fruitback/worker`) — the Node service. `POST /feedback` plants a note,
  `GET /feedback?url=…` returns the notes of that page. Still called "worker" because that is what
  everyone calls it, though it is no longer an edge worker.
- `packages/widget` (`@fruitback/widget`) — the browser half, and now the whole of it: **capture**
  (`captureNote`, FRU-5), **the overlay** (`resolveAnchor` + `createOverlay`, FRU-11), **the
  Shadow DOM host** (`createCaptureHost`, FRU-3) and **the note popover** (`createComposer`,
  FRU-4). The playground only says where the worker is.

- `apps/extension` (`@fruitback/extension`) — the browser extension (FRU-41): the same widget, on a
  site that embeds nothing. wxt, MV3 on Chromium **and** Firefox. Two content scripts, one per world
  — see _The extension, and the two worlds_ ([extension.md](extension.md)).
- `apps/playground` (`@fruitback/playground`) — the dev loop (FRU-19, FRU-20): a deliberately
  hostile fake client site with the widget mounted on it. **A React Router 8 + Vite app with HeroUI**
  since FRU-20, because the widget's clients are React apps and a static page could not exercise
  half of what the widget does. Not shipped, not deployed.

## The milestones, as the README carried them

Archived here when the README became a landing page (FRU-26). It had gone stale where it mattered
most — it still named `FRU-2 → FRU-8 → FRU-11` as the critical path, which was schema, write and
read-back, all three long shipped. A roadmap on a landing page is a promise that ages badly; the live
one is [the Linear project](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6).

| Milestone            | Scope                                                     |
| -------------------- | --------------------------------------------------------- |
| 🌱 M1 Foundation     | monorepo, note schema + Linear mapping                    |
| 🍓 M2 Capture        | react-grab in Shadow DOM, popover, anchor, screenshot     |
| 🍊 M3 Write → Linear | worker, issue creation, anonymous/identified attribution  |
| 🥝 M4 Read & overlay | query by label + URL, re-anchoring, orphan pins, comments |
| 🫐 M5 Config in-app  | settings panel, multi-client mapping                      |
| 🥥 M6 Packaging      | npm package, install snippet, optional Linear webhook     |
