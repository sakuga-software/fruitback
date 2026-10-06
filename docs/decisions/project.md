# The project, and the layout

**What `CLAUDE.md` used to say**, before FRU-59 condensed both sections. The current versions are
in [CLAUDE.md](../../CLAUDE.md) and they are the ones to trust — the Layout below predates
`packages/fruitback` and the settings panel, and names `packages/widget`'s parts by the tickets that
built them.

It is kept because each section carries a history the condensed version drops: what the project
claimed about itself before FRU-31 gave the worker a store of its own, and which ticket built which
part of the widget.

## Project

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes an issue carrying the CSS selector, the React component and the source file.
Coming back to the page, they see their pins again, coloured by that issue's status.

**Fruitback does not reinvent issue tracking — but it no longer requires somebody else's account.**
That is a change, and FRU-31 made it deliberately. This file used to say _there is no Fruitback
backend, Linear is the database_, and until the SQLite connector that was exactly true. It is not any
more: `FRUITBACK_STORE=sqlite` puts the seeds in a file on a volume, and a self-hoster who wants no
third party has a door.

What has **not** changed is the instinct behind that sentence. Status, threads, assignees and history
still belong to the store, never to a second model kept in step with it — and every store the worker
speaks to is one somebody already runs. Linear stays the default and the richest of them: the
dashboard, the triage, the API, the MCP server and the integrations all come for free. See
[README.md](../../README.md) for the reasoning and the alternatives that were dropped.

Deployment is **Docker on a VPS, driven by Dokploy from GitHub** — no Cloudflare, no serverless, no
managed platform primitives. When something needs infrastructure, reach for what a single container
behind Traefik can do.

## Layout

- `packages/shared` (`@fruitback/shared`) — the seed contract. Browser- and server-safe: no Node API,
  no DOM API beyond `URL`. Also exports `@fruitback/shared/seed.fixture`, so every package tests
  against the same seed instead of keeping a drifting copy.
- `apps/worker` (`@fruitback/worker`) — the Node service. `POST /feedback` plants a seed,
  `GET /feedback?url=…` returns the seeds of that page. Still called "worker" because that is what
  everyone calls it, though it is no longer an edge worker.
- `packages/widget` (`@fruitback/widget`) — the browser half, and now the whole of it: **capture**
  (`captureSeed`, FRU-5), **the overlay** (`resolveAnchor` + `createOverlay`, FRU-11), **the
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
| 🌱 M1 Foundation     | monorepo, seed schema + Linear mapping                    |
| 🍓 M2 Capture        | react-grab in Shadow DOM, popover, anchor, screenshot     |
| 🍊 M3 Write → Linear | worker, issue creation, anonymous/identified attribution  |
| 🥝 M4 Read & overlay | query by label + URL, re-anchoring, orphan pins, comments |
| 🫐 M5 Config in-app  | settings panel, multi-client mapping                      |
| 🥥 M6 Packaging      | npm package, install snippet, optional Linear webhook     |
