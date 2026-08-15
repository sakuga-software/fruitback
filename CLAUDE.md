# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes a Linear issue carrying the CSS selector, the React component and the source
file. Coming back to the page, they see their pins again, coloured by Linear status.

**There is no Fruitback backend. Linear is the database.** The only server-side piece is a proxy
service that holds the Linear token. Anything that looks like it needs storage — status, threads,
assignees, history — belongs in Linear, not here. See [README.md](README.md) for the reasoning and
the alternatives that were dropped.

Deployment is **Docker on a VPS, driven by Dokploy from GitHub** — no Cloudflare, no serverless, no
managed platform primitives. When something needs infrastructure, reach for what a single container
behind Traefik can do.

## Commands

Package manager is `pnpm@11.16.0` (pinned). Nx runs multi-project targets.

```bash
pnpm install
pnpm dev                                    # worker (in-memory Linear) + playground, see below
pnpm test                                   # nx run-many -t test → node --test
pnpm e2e                                    # playwright, starts both servers itself
pnpm typecheck
pnpm lint                                   # oxlint
pnpm format:fix                             # oxfmt

pnpm --filter @fruitback/shared test         # one package
pnpm --filter @fruitback/shared test:watch
node --test src/seed.test.ts                 # one file, from the package directory
```

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

- `apps/playground` (`@fruitback/playground`) — the dev loop (SKG-511, SKG-512): a deliberately
  hostile fake client site with the widget mounted on it. **A React Router 8 + Vite app with HeroUI**
  since SKG-512, because the widget's clients are React apps and a static page could not exercise
  half of what the widget does. Not shipped, not deployed.

## The dev loop

**`pnpm dev` starts both halves. The ports are fixed, and these are them:**

| | |
| --- | --- |
| `http://localhost:5177` | the playground page |
| `http://localhost:8788` | the worker, on its in-memory Linear |

`8788` and not `8080`: 8080 is the container's port, and something is usually already sitting on it
on a developer's machine. `/tf` and `/tfp` read these numbers from here rather than probing.

- **`FRUITBACK_FAKE_LINEAR=1` swaps the real Linear for `linear-memory.ts`**, so the whole loop —
  capture, issue, pins coloured by state — runs with no API key and writes to nobody's workspace. It
  is refused under `NODE_ENV=production` (which the Dockerfile sets), `/health` answers
  `{ ok: true, fakeLinear: true }`, and the boot log says so. It is **not** a mock: an issue is
  stored as the description `buildIssueDescription` produces and read back through the same
  `toSeedIssue` as production, so a broken round trip breaks the playground too.
- **The playground is a React app on purpose, and it is the only place three things are true.** The
  widget mounts in an effect, so it arrives *after* hydration. A client-side navigation changes the
  page identity with no page load to notice it. And `source` finally has a fiber to read, which is
  the half of a seed that says *which component* a note is about. Each of those found a real defect
  the moment it first ran — see below.
- **A re-render is invisible to the widget.** It re-measures on scroll and resize; neither fires when
  React swaps a subtree, so the pins have to be resolved again. `fruitback.tsx` does that because the
  host *caused* the re-render and therefore knows. **A real client site does not** — closing that gap
  is still open work, and this playground exists to have made it visible.
- The toolbar and `fruitback.tsx` are **scaffolding, not the product** — SKG-492/493 replace the
  capture UI, SKG-500 replaces the re-anchoring. Do not grow features there; grow them in
  `packages/widget`.
- `apps/playground/.react-router/` is typegen, regenerated on dev and build. It is ignored, not
  committed.

## The E2E suite

`pnpm e2e` (Playwright, `e2e/`) starts both servers itself and runs its specs against Chromium.

- It exists for the two things happy-dom cannot vouch for: a **real selector engine** and **real
  layout**. Everything else stays in `node --test`, which is where it is faster and clearer.
- Specs share one worker process, so each captures on **its own page URL** (`/?case=…`) — the seed's
  page identity is what keeps them apart. There is no reset between specs.
- Synchronise on the harness's status line, not on a pin count: the old pins are still in the DOM
  while the new set is being fetched, so counting races.
- **Assert on colours by polling, not by reading once.** A design system animates its own colours,
  and a computed style read mid-transition is the interpolated value — which Chromium serializes in a
  different colour space (`oklab(…)` where the resting declaration says `oklch(…)`). The same colour,
  a different string.
- It has already earned its keep four times: the browser caching `GET /feedback` and serving the
  widget its own stale answer right after planting a pin; `domPath` resolving cleanly onto the
  neighbouring card; React 19's `useId` format accepted as a stable id; and the fiber walk throwing on
  the `null` owner React ends every tree with, which stopped a click from planting anything at all.

## The widget

- **`captureSeed` is the only place a seed is built.** It goes through `createSeed`, so a malformed
  anchor fails in the reporter's browser instead of as a `400` after the note was typed.
- The anchor is deliberately redundant — selector, `domPath`, text, attrs, bounds — because the site
  will be redeployed between writing the note and reading it. `selector.ts` does not answer "what
  selects this element" (any `:nth-child` chain does) but **"what still selects it next week"**: test
  ids and author-written ids win, a `useId` `:r7:` and a CSS-modules class are refused. Whatever
  comes out is verified unique against the document before being returned.
- When nothing identifies an element that repeats (three identical cards), the selector is **scoped
  under the nearest identifiable ancestor** rather than pathed from `<html>`.
- `page.url` is canonicalized here too. The worker re-does it — it cannot trust a client — but doing
  it on this side is what makes the widget query the read path with the key its seeds were stored
  under.
- **react-grab owns `source`, but only field by field.** `captureSeed({ source })` wins per field
  and `readReactSource` fills the gaps — a best-effort walk over React's `__reactFiber$` internals
  that returns `undefined` at the first surprise rather than guessing a file name. Merging rather
  than choosing is not tidiness: on a design system react-grab gets `file`/`line` right and the
  component name wrong, and the fiber walk is exactly what knows the name.
- **A component name a bundler minted is worse than none.** Pointing at a HeroUI button reports
  `bound $7230ffa83bc0c2cf$var$DOMElement` — the react-aria internal that rendered the host node,
  scope-hoisted by Parcel. Nobody can search for it. `isMangledComponentName` drops those and the
  walk continues to the first name a human wrote, which for a HeroUI button is `Button` — the
  component that really rendered the node. It deliberately does **not** climb to the app's own
  component: that would report `PlanCard` for anything nested, which is less true and no more useful
  now that `file`/`line` point at the JSX.
- **The owner chain ends in `null`, not `undefined`.** Both walks stop on either. Checking only for
  `undefined` dereferences the root, throws out of `captureSeed`, and a click silently stops planting
  anything — which is what happened the first time the widget met a real React tree.
## The host, and why everything lives in one Shadow root

- `createCaptureHost` owns the widget's DOM: the floating button, the hover highlight, and — through
  `host.root` — the overlay's pins and whatever the note UI turns out to be.
- **A Shadow root is the only version of "no style conflicts" that survives a real client site.** It
  stops their `button { width: 100% !important }` from reshaping our toolbar *and* our rules from
  reaching their page. Neither direction is achievable with prefixed class names.
- `:host { all: initial }` on top, because a Shadow root blocks the page's *selectors* but not its
  **inherited** properties — `body { font-family: Papyrus }` reaches in otherwise. The catch: `all:
  initial` also undoes the browser's `display: none` on `<style>`, which then renders the stylesheet
  as visible text in the corner of the client's page. Hence `style, script { display: none }`. Both
  are covered by E2E tests, because neither is visible to a DOM emulator.
- **The host sits at the document origin, absolutely positioned, with no size.** The overlay places
  pins in document coordinates, and absolute positions resolve against the nearest positioned
  ancestor — move or offset the host and every pin moves with it.
- **`engine.ts` is the whole surface we take from react-grab**: hit testing that crosses shadow roots
  and iframes, viewport bounds, and the source context. Three functions behind an interface, so the
  unit tests hand over a fake — happy-dom has neither `elementsFromPoint` nor layout — and a library
  change lands in one file.
- **Hit testing has to be told to ignore us**, since react-grab traverses open shadow roots and would
  otherwise return our own highlight box. `ignore` extends that to chrome the *page* mounts around
  the widget (the dev toolbar today, SKG-503's config panel next). Note what it does not do:
  react-grab walks *past* a rejected candidate, so hovering our own chrome highlights whatever is
  behind it. Harmless; capturing it would not be.
- **Never `instanceof Element` in this package.** It reads a class off one realm, and an element from
  a same-origin iframe — which react-grab returns on purpose — belongs to another. Use `isElement`
  from `dom.ts`.

## The popover

- **`createComposer` owns the states, not the transport.** `onSubmit` is awaited, so an embedder
  posts through whatever it set up while the widget stays ignorant of the worker's URL and of auth.
- The states are the point, and they are unit-tested because none of them can be seen by looking:
  the send button is disabled in flight (**a second click would plant the same note twice**, and the
  worker cannot tell the difference), a failure keeps the popover open **with the text intact**, and
  a refusal (`onSubmit` resolving `false`) is treated as a failure rather than a success.
- **Losing what someone just wrote is the one failure this widget cannot afford.** Anything that
  would clear the field on an error path is a bug, however tidy it looks.
- Popover on desktop, **sheet on a phone** — a 320px popover anchored to an element is unusable at
  that width. The anchored position goes through `--fb-composer-*` custom properties rather than
  inline `left`/`top`, because an inline style beats the media query and leaves the sheet offset.
- `prefers-reduced-motion` turns the animations **off**, both here and on the pin. A widget that
  overlays someone else's site is the last thing that should ignore that setting.
- The pin is a drop: three round corners and one sharp, rotated to point at its element, with a
  squash-and-stretch entrance. The note moved to the badge's `aria-label` — that is what keeps it
  reachable by a screen reader, and by a test looking for it by role.

## Re-anchoring, and why a pin says how sure it is

- `resolveAnchor` walks the anchor's claims in the order `SEED_ANCHOR_STRATEGIES` declares:
  **selector → testId → text → domPath → bounds**. That order is the contract's, and it puts `text`
  ahead of `domPath` deliberately.
- **Every match must be unique and of the captured tag**, and `domPath` must additionally still be
  roughly where the seed said it was — a structural path always resolves to *something*, and after
  an insertion that something is the neighbour.
- **`confident` is the field that matters.** `selector`, `testId` and `text` identify an element;
  `domPath` and `bounds` only locate a spot. Delete a card from a grid and its neighbour slides into
  the vacated slot with the same tag, the same text and the same box — nothing a seed stores can
  separate them. So the pin is still placed, drawn dashed with a `≈`, and its thread says it was
  found by position rather than recognised. Do not "fix" this by making the cascade stricter without
  reading `resolve.test.ts` first: refusing outright throws away the many cases where position is
  exactly right.
- The overlay positions in **document coordinates** and re-measures on scroll and resize — a
  `position: fixed` header moves relative to the document as the page scrolls.
- **Pins let clicks through**; only the badge is clickable. A widget that swallows the client's own
  buttons is one they turn off.
- `createOverlay({ host })` takes where to render. It defaults to `<body>`; SKG-492's Shadow root
  passes itself there, which is what finally isolates these styles.
- Tests run against **happy-dom** (`dom.fixture.ts`), a devDependency of this package only —
  uniqueness and sibling questions cannot be answered honestly by a hand-rolled fake. Nothing outside
  `*.test.ts` and `*.fixture.ts` may import it, and `tsconfig.json` excludes both so the shipped code
  still compiles with `types: []`.

## The worker

- It exists for exactly one reason: the Linear API key cannot ship in client-side JS. Resist putting
  logic here that belongs in the widget or in Linear.
- **`app.ts` is transport-agnostic** — a `handleRequest(request, env, context)` over web
  `Request`/`Response`. `server.ts` adapts `node:http` onto it and `main.ts` starts it. Keep new
  behaviour in `app.ts` so it stays testable without opening a socket.
- The env is validated up front (`readConfig`), so a missing secret surfaces at boot and on
  `/health`, not as an opaque Linear error per request.
- `POST /feedback` re-canonicalizes `seed.page.url` server-side. The read path finds seeds by
  matching that URL inside the description, so a client that skipped normalization would plant a pin
  nobody can find again. `GET /feedback` canonicalizes its `url` parameter for the same reason.
- **The `description contains` filter is a substring match**, so `/pricing` also matches the seeds of
  `/pricing?tab=annual`. `fetchSeedIssues` therefore re-checks `seed.page.url` exactly before
  returning an issue — dropping that check silently mixes two pages' pins.
- The read cache (`cache.ts`) holds the in-flight promise, not the value, so a burst of visitors on
  one page costs one Linear call. Failures are evicted at once: an outage must not be served for the
  whole TTL. In-process, therefore per replica — same caveat as the rate limiter.
- Failure codes are deliberate: `400` the caller's fault, `403` origin not allowed, `413` oversized
  body, `429` rate-limited, `500` misconfigured, `502` Linear unavailable (the widget should keep the
  note and retry). `/health` answers `503` when misconfigured so a bad deploy is never routed to.
- **`resolveClientIp` is security-relevant.** `X-Forwarded-For` is appended to by each proxy, so the
  left of the chain is caller-controlled and forgeable; the client IP is the entry
  `TRUSTED_PROXY_HOPS` from the **right**. Reading the leftmost entry — correct behind Cloudflare,
  wrong behind Traefik — makes the rate limit bypassable with one header.
- The rate limiter is in-process, therefore **per replica**. Scaling to N containers multiplies the
  effective ceiling by N; a shared store is the fix if that ever matters.
- Tests drive `handleRequest` with plain `Request` objects against a stubbed Linear
  (`linear-stub.ts`); no container needed. The assertion that matters most is that the stored
  description parses back into the exact seed that was posted.
- `reporter` in an incoming seed is **client-asserted and unverified** — do not treat it as identity
  until SKG-498 lands.

## The seed contract

`packages/shared` is the contract both ends depend on. Treat changes to it as breaking.

- A **seed** is one pin: `note`, `page`, `viewport`, `anchor`, plus optional `source` (react-grab),
  `client`, `reporter`, `env`, `screenshot`.
- **The round-trip is the invariant**: `parseSeedFromDescription(buildIssueDescription(seed))` must
  return exactly `seed`. Two rules protect it — **no schema default values**, and no field the
  widget cannot rebuild from what is stored. Adding a default is the easy way to break this
  silently; the test `adds no field the caller did not provide` is there to catch it.
- **Bump `SEED_VERSION`** when the payload shape changes. Readers accept older versions and refuse
  newer ones (`unsupported-version`) rather than silently dropping fields.
- **`parseSeed*` never throws.** It returns `{ ok: false, reason }` — the input is a Linear
  description a human may have edited.
- `canonicalizePageUrl` is the page identity: fragment and tracking params dropped, remaining params
  sorted. It must stay idempotent, and its output must appear verbatim in the description — that is
  what makes the Linear `description: { contains: … }` filter work.
- Pin colour comes from `stageForLinearState` (Linear workflow state type → fruit stage). The widget
  never stores a status of its own.

## Conventions

- Formatting and linting are oxfmt / oxlint (config at the root). 120 columns, single quotes,
  trailing commas.
- **Tests run on `node:test` and `node:assert/strict`** — no test runner, no transpiler, no loader.
  `pnpm test` is `node --test 'src/**/*.test.ts'`; Node strips the types itself. Colocated as
  `*.test.ts`, fixtures in `*.fixture.ts`.
  - `assert.equal` / `assert.deepEqual` from `node:assert/strict` are the strict variants — no need
    for `strictEqual`.
  - Partial matching is `assert.partialDeepStrictEqual`. There is no `expect.arrayContaining`; assert
    the exact array, or narrow first with `assert.ok(result.ok)` and then compare.
  - Doubles come from `node:test`'s `mock` (`mock.method(globalThis, 'fetch', …)`), restored with
    `mock.restoreAll()` in an `afterEach`.
- **Relative imports carry the `.ts` extension.** Node's ESM resolver requires it, and that is what
  lets `node --test` and `node --watch src/main.ts` run the sources with no build step. `tsc` accepts
  it through `allowImportingTsExtensions`, which is why both tsconfigs set `noEmit`.
- `packages/shared` keeps `types: []` on purpose — it is bundled into a browser widget, so touching
  `process` or `Buffer` must fail to compile. Its tests need Node types, so they typecheck through a
  separate `tsconfig.test.json`; do not "fix" this by adding `node` to the main config.
- **No backticks inside the CSS template literals** (`STYLES` in `host.ts`, `overlay.ts`,
  `composer.ts`). A comment quoting a symbol closes the literal and the file stops parsing. It has
  happened twice; the failure is loud — the module will not load — but the cause reads as a mystery
  until you look at the right line.
- Comments explain _why_, not _what_ — the tolerant parser and the redundant anchor both exist for
  reasons that are not obvious from the code.
- Work is tracked in Linear on the
  [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team SKG).
  Reference tickets as `SKG-xxx` in commits.

## Linear MCP

The Linear MCP server is declared in [.mcp.json](.mcp.json) at the project scope. If its tools are
missing in a session, it needs to be approved and authorized (`/mcp` in an interactive session) —
it cannot be authorized from a non-interactive one.
