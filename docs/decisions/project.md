# The project, and the layout

The two sections `CLAUDE.md` states as they stand today. Kept here as they were written, because
each carries a history the condensed version drops: what the project said about itself before
SKG-524 gave it a store of its own, and which ticket built each part of the widget.

## Project

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes an issue carrying the CSS selector, the React component and the source file.
Coming back to the page, they see their pins again, coloured by that issue's status.

**Fruitback does not reinvent issue tracking — but it no longer requires somebody else's account.**
That is a change, and SKG-524 made it deliberately. This file used to say *there is no Fruitback
backend, Linear is the database*, and until the SQLite connector that was exactly true. It is not any
more: `FRUITBACK_STORE=sqlite` puts the seeds in a file on a volume, and a self-hoster who wants no
third party has a door.

What has **not** changed is the instinct behind that sentence. Status, threads, assignees and history
still belong to the store, never to a second model kept in step with it — and every store the worker
speaks to is one somebody already runs. Linear stays the default and the richest of them: the
dashboard, the triage, the API, the MCP server and the integrations all come for free. See
[README.md](README.md) for the reasoning and the alternatives that were dropped.

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
  (`captureSeed`, SKG-494), **the overlay** (`resolveAnchor` + `createOverlay`, SKG-500), **the
  Shadow DOM host** (`createCaptureHost`, SKG-492) and **the note popover** (`createComposer`,
  SKG-493). The playground only says where the worker is.

- `apps/extension` (`@fruitback/extension`) — the browser extension (SKG-534): the same widget, on a
  site that embeds nothing. wxt, MV3 on Chromium **and** Firefox. Two content scripts, one per world
  — see *The extension, and the two worlds* ([extension.md](extension.md)).
- `apps/playground` (`@fruitback/playground`) — the dev loop (SKG-511, SKG-512): a deliberately
  hostile fake client site with the widget mounted on it. **A React Router 8 + Vite app with HeroUI**
  since SKG-512, because the widget's clients are React apps and a static page could not exercise
  half of what the widget does. Not shipped, not deployed.

