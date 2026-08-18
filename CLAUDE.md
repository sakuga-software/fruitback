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
- **A re-render used to be invisible to the widget**, and the playground re-resolved by hand because
  the host had caused it and therefore knew. A client's app cannot know, so SKG-513 moved that into
  the overlay: `fruitback.tsx` now only *reports* what the widget decided, through `onResolve`. The
  proof that the gap is really closed is that deleting the manual call left `reanchor.spec.ts` green
  — and that restoring the old overlay makes all three of its specs fail.
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
- **A cold Vite cache is the difference between your machine and CI.** Vite binds its port — so it
  answers Playwright's readiness probe — before it has optimized dependencies, and it discovers most
  of them only when a browser asks for the module graph. The first navigation then triggers a
  re-optimization, in-flight requests return `504 (Outdated Optimize Dep)`, and the page reloads
  underneath the running spec. `optimizeDeps.include` is **not** enough on its own (React Router
  optimizes its SSR environment separately); the guarantee is `e2e/warm-up.ts`, a `globalSetup` that
  loads the app once before anything is measured. Reproduce the CI condition with
  `rm -rf apps/playground/node_modules/.vite`.
- **Assert on colours by polling, not by reading once.** A design system animates its own colours,
  and a computed style read mid-transition is the interpolated value — which Chromium serializes in a
  different colour space (`oklab(…)` where the resting declaration says `oklch(…)`). The same colour,
  a different string.
- It has already earned its keep four times: the browser caching `GET /feedback` and serving the
  widget its own stale answer right after planting a pin; `domPath` resolving cleanly onto the
  neighbouring card; React 19's `useId` format accepted as a stable id; and the fiber walk throwing on
  the `null` owner React ends every tree with, which stopped a click from planting anything at all.

## The published package

- **Three packages, and only one of them is the front door.** `fruitback` is what a client installs:
  it depends on `@fruitback/widget` and `@fruitback/shared` and re-exports both, so mounting the
  widget and naming what it stores is one install and one import.
- The two scoped packages stay published because the front door depends on them, not because anyone
  is expected to reach for them. The contract had to be published at all because the widget's emitted
  `.d.ts` name its types, and types that point at something nobody can install are worse than none.
- **`packages/fruitback` re-exports and defines nothing.** Anything declared there rather than
  forwarded would be a third place for the contract to drift. It is not bundled either: the two
  packages it forwards are real dependencies, so there is one copy of the widget on disk.
- **`public.ts` is the contract, `index.ts` is the workspace.** Everything is exported somewhere
  because the playground and the tests reach into the parts; only what `public.ts` names cannot
  change without a major version. `init` and what it hands back is all of it — deliberately **not**
  the config store, which would be a preference we could never change under a host.
- **`embed.ts` is the only file that knows the worker exists.** `composer.ts` is still handed an
  `onSubmit`; the transport lives in the assembly layer because that is the layer that was always
  going to have to know.
- **`init` patches `history.pushState`/`replaceState`** and restores them on `destroy`. A pin belongs
  to a URL, `popstate` does not fire for a `pushState`, and there is no framework to ask on a client's
  site. The alternative was polling `location.href` for ever.
- The `workspace` fields point at **source**; `publishConfig` swaps in `dist` when pnpm packs. That is
  what lets a developer edit the file they are looking at while a consumer gets the build. **Both
  packages need it** — publishing the contract while `main` still pointed at `src/index.ts` shipped a
  package whose own imports carry the `.ts` extension only this repo allows, and a downstream `tsc`
  failed with `TS5097` while every check here stayed green.
- **`rewriteRelativeImportExtensions` rewrites the JavaScript and not the declarations.** Both builds
  therefore post-process their `.d.ts` and then assert no `.ts` extension survived.
- **All three packages need `prepack`.** `pnpm pack` and `pnpm publish` build through it; without one the
  tarball ships `src` and nothing else, while `publishConfig` points at a `dist` that is not there.
  That is the same defect as the paragraph above, arriving a different way — first as `TS5097`, then
  as an unresolvable module.
- **The guard that matters is `type-checks an import with no special tsconfig`**: it deletes every
  `dist`, packs all three, asserts each tarball actually contains one, installs them into a scratch
  project and type-checks an import **from `fruitback` and from both scoped packages**, with
  `skipLibCheck` **off**. Every clause is there because something without it shipped green — building
  before packing hid a missing `prepack`, importing only the widget would have missed a broken
  `exports` on the front door, and `skipLibCheck` skips the declarations the contract package exists
  to make resolvable.
- **Read the file after editing this guard.** Two of those clauses were described here, and in a PR
  reply, while the edit that would have added them had silently not applied. A guard is worth what it
  runs, not what its docstring says.
- `react-grab` and `zod` are **bundled, and are devDependencies**: a client site must not have to
  install — or resolve a version conflict over — a library it never asked for.
- The ESM build is left readable (the consumer's bundler minifies it); the IIFE is minified because it
  lands on a page exactly as built. **93 kB gzipped**, guarded by a test that trips at 150 kB — a
  tripwire for a dependency that should have been bundled out, not a budget.
- **The README snippet is executed by the suite**, not merely quoted: `package.spec.ts` serves the
  built IIFE through `page.route` and appends the documented tag with its `data-` attributes, which
  is the only way to exercise the auto-mount — `addScriptTag` cannot set attributes. A snippet in a
  doc that nobody runs is a snippet that stops working quietly.
- **`pnpm e2e` builds `dist` first.** `package.spec.ts` loads the real file, and a fresh checkout has
  no build.

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
- **Name and e-mail are optional, behind a disclosure, and never `verified`** (SKG-498). Anonymous
  is what happens if the reporter does nothing, and the widget states a claim rather than an
  identity — the flag that would make it one is the worker's to set.
- **Losing what someone just wrote is the one failure this widget cannot afford.** Anything that
  would clear the field on an error path is a bug, however tidy it looks.
- Popover on desktop, **sheet on a phone** — a 320px popover anchored to an element is unusable at
  that width. The anchored position goes through `--fb-composer-*` custom properties rather than
  inline `left`/`top`, because an inline style beats the media query and leaves the sheet offset.
- **`all: initial` resets `display` too.** Every block element in the Shadow root is inline until the
  stylesheet says otherwise, and vertical margins on it silently do nothing — the note thread ran its
  note, byline and warning together into one line. `display` is restored at the reset in `host.ts`,
  next to the `style, script { display: none }` rule that is there for the same reason, so the next
  element added to the widget does not meet the surprise again.
- `prefers-reduced-motion` turns the animations **off**, both here and on the pin. A widget that
  overlays someone else's site is the last thing that should ignore that setting.
- The pin is a drop: three round corners and one sharp, rotated to point at its element, with a
  squash-and-stretch entrance. The note moved to the badge's `aria-label` — that is what keeps it
  reachable by a screen reader, and by a test looking for it by role.

## The settings panel

- **What is not configurable is the design** (SKG-503). The ticket asked for the Linear team, project
  and labels; they are absent. Since SKG-504 the worker resolves those from the client id and refuses
  an id it does not know, so a browser naming its own team would either be ignored — a setting that
  does nothing is worse than none — or obeyed, which lets any page write into any workspace. The
  client id is what the reporter can say; what it routes to stays server-side.
- `config.ts` is the store, `panel.ts` the UI. It writes on every change rather than behind a Save
  button, and **reading `localStorage` can throw** rather than return `null` — Safari in private
  browsing raises on the property itself, so the widget must still start with storage refused.
- **The stored config is parsed like a seed**: tolerant, field by field. It is a string a human can
  edit in devtools, and a malformed one costs the reporter their preferences, never the widget.
- **Filtering lives in the overlay, not in the embedder.** `shouldShow` plus `refilter` redraw from
  the issues already held, so hiding a stage costs no request — and, as with SKG-513, a client's app
  is not going to re-fetch on the widget's behalf.
- **Do not use generic tags in the widget's chrome.** Playwright's selectors pierce open shadow
  roots, so a `<header>` in the panel made the page's own `header button` ambiguous for anything
  reading the composed tree. The panel uses a `div`, and the E2E specs scope to `main header button`.
- **Two elements must not share one accessible name.** The gear says `Ouvrir les réglages Fruitback`
  and the dialog `Réglages Fruitback`; giving both the same name is ambiguous to a screen reader and
  to any test that finds elements by name.

## The team's replies

- **Comments come from Linear on every read** (SKG-502), and close the loop: someone leaves a note,
  the team answers in the issue, and the answer appears where the note was left rather than in an
  inbox the reporter does not have.
- **Absent and empty mean different things.** No `comments` field at all means the worker was not
  asked for them, and the widget says nothing; `[]` means it asked and there were none, and the
  widget says so. A client with replies switched off must not read as a team that never answered.
- **`showComments` is on by default and is a real switch**, per client or worker-wide
  (`FRUITBACK_HIDE_COMMENTS=1`). The read path needs no authentication, so anything surfaced there is
  readable by anyone who can load the client's page — a team that treats its issue comments as
  internal turns it off.
- The switch is applied in **`toSeedIssue`**, which both the real Linear and the in-memory one go
  through, rather than only through the query's `first:` argument. `first: 0` is an assumption about
  what Linear accepts, and this promise should not rest on a backend behaving a particular way.
- **A comment body is `textContent`, never markup.** It is Linear markdown written by anyone who can
  comment on the issue, rendered inside someone else's page; treating it as HTML would make the
  feedback widget the way into their site.
- Sorted oldest-first in the worker, because Linear answers newest-first and a conversation reads the
  other way. Capped at `COMMENTS_PER_ISSUE` — a longer thread belongs in Linear, which the pin links
  to.

## Re-anchoring, and why a pin says how sure it is

- `resolveAnchor` walks the anchor's claims in the order `SEED_ANCHOR_STRATEGIES` declares:
  **selector → testId → text → domPath → bounds**. That order is the contract's, and it puts `text`
  ahead of `domPath` deliberately.
- **Every match must be unique and of the captured tag**, and `domPath` must additionally still be
  roughly where the seed said it was — a structural path always resolves to *something*, and after
  an insertion that something is the neighbour.
- **Detached is not the same as unsure** (SKG-501). A pin found only by `bounds` is still placed,
  dashed, and marked unconfident — that is SKG-500's answer and the orphan list does not touch it.
  `orphans.ts` lists only the notes where the cascade found **nothing**: `resolution.element === null`.
  Listing the unsure ones would tell a reporter their note is lost while it sits on the right element.
- **The list is a sibling of the overlay's container, so `isOurs` has to be told about it.** It was
  not, and rebuilding it on every resolve mutated the document, which scheduled another resolve,
  which rebuilt it: a loop the observer's own guard exists to prevent. `orphans.owns` is what closes
  it, and `update` is short-circuited on an unchanged set so the common case writes nothing at all.
- The list **shows itself only when it holds something**, and lives in the widget's own corner,
  stacked above the dock. Claiming a second corner of someone else's page is how a widget lands on
  top of their cookie banner — it went under the playground's toolbar the first time.
- **`confident` is the field that matters.** `selector`, `testId` and `text` identify an element;
  `domPath` and `bounds` only locate a spot. Delete a card from a grid and its neighbour slides into
  the vacated slot with the same tag, the same text and the same box — nothing a seed stores can
  separate them. So the pin is still placed, drawn dashed with a `≈`, and its thread says it was
  found by position rather than recognised. Do not "fix" this by making the cascade stricter without
  reading `resolve.test.ts` first: refusing outright throws away the many cases where position is
  exactly right.
- The overlay positions in **document coordinates** and re-measures on scroll and resize — a
  `position: fixed` header moves relative to the document as the page scrolls.
- **It also watches the page, because nothing announces a re-render** (SKG-513). A `MutationObserver`
  on `childList`/`subtree` re-resolves every pin, debounced, and a `ResizeObserver` on each anchored
  element catches what moves without the structure changing. Deliberately **not** `attributes`: a
  design system toggles classes on every hover, and an element that merely changed class is still
  where it was — what must be caught is the element being *replaced*, which is always a childList
  change.
- **`resolve()` is not `render()`.** `render` takes new data and rebuilds, which closes the thread;
  `resolve` keeps the pins and the open thread and only updates what was *found*. A page that mutates
  while someone is reading a note is the normal case on an SPA, so slamming the thread shut is not an
  option. It re-applies the confidence marks too: a pin that fell from `selector` to `bounds` used to
  keep claiming it had been recognised, because those were written once at build time.
- **Take `MutationObserver` and `ResizeObserver` off the document's own window**, never off
  `globalThis` — the same realm rule as `isElement`. Reading the global gets Node's (which has
  neither), and the widget then watches nothing at all, silently. A unit test caught this; nothing
  else would have.
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
- **`FRUITBACK_CLIENTS` makes one worker serve several client sites** (SKG-504). It maps a
  `clientId` to a team, a project and the origins that client may be embedded on. Absent, nothing
  changes: one team, one project, `client` optional on a read.
- **Configured, a client has to be named on both paths** — the `client` parameter on a read,
  `seed.client.id` on a write — and an unknown one is refused. A read that named nobody used to
  answer with every seed on that URL, which on a shared worker is one client reading another's
  feedback; a write that names nobody would land in the default team, which is the same leak facing
  the other way. The read cache key carries the team for the same reason.
- **`normalizeClientId` runs before the id is used for anything**, and that ordering is the whole
  point. The id does three jobs — it picks the route, it builds the `fruitback:<id>` label a read
  filters on, and it keys the cache. Normalising it for the route alone put a note in the right team
  under `fruitback:  acme  ` while its owner's clean read asked for `fruitback:acme` and found
  nothing: authorised at both ends, invisible in between. The write path normalises it into the seed
  the same way it re-canonicalises `page.url`, and for the same reason.
- **`clientId` is client-asserted**, and SKG-498 did not change that: identity tokens say who the
  *reporter* is, not which client the page is. `origins` is what turns the claim into something
  checkable against the browser's own header — the trust level CORS gives, and strictly more than
  nothing. Do not describe it as authentication.
- A malformed `FRUITBACK_CLIENTS` is refused at boot rather than ignored, and named on `/health`.
- The rate limiter is in-process, therefore **per replica**. Scaling to N containers multiplies the
  effective ceiling by N; a shared store is the fix if that ever matters.
- Tests drive `handleRequest` with plain `Request` objects against a stubbed Linear
  (`linear-stub.ts`); no container needed. The assertion that matters most is that the stored
  description parses back into the exact seed that was posted.
- **`reporter.verified` is the worker's word, never the client's** (SKG-498). Anything arriving with
  that flag has it stripped, whatever else it says: without that, a browser posting
  `reporter: { name: 'CEO', verified: true }` reads in Linear exactly like an identity this worker
  checked. `identity.ts` sets it only after verifying a **standard compact JWT (HS256)** against the
  client's `identitySecret` (or `FRUITBACK_IDENTITY_SECRET` on a single-client worker), so a client
  site mints one with whatever library it already has.
- **`alg` is asserted against the token, never read from it.** That interoperability is what makes
  the header an attack surface: a verifier that trusts the token's own algorithm accepts `alg: none`
  and validates everything. Anything but `HS256` is refused before a byte of the signature is looked
  at, and the signing input is `header.payload` so swapping the header breaks the signature. Both are
  tested, and both tests fail if the check is removed.
- **The identity token arrives in an `Authorization` header, never in the seed.** The seed is stored
  verbatim in an issue description anyone with workspace access can read, so a credential in there
  would outlive its expiry by months.
- A token that fails to verify is a **401**, not a downgrade to anonymous: a site that meant to
  identify someone and got it wrong should hear about it, rather than have a broken integration go
  unnoticed for a month. No token at all is fine and stays the default.
- `exp` is **required** in the claims — a token that never expires is a password. Signatures are
  compared in constant time, because a `===` on the base64 leaks how much of it was right.

## The seed contract

`packages/shared` is the contract both ends depend on. Treat changes to it as breaking.

- A **seed** is one pin: `note`, `page`, `viewport`, `anchor`, plus optional `source` (react-grab),
  `client`, `reporter`, `env`, `screenshot`.
- **The round-trip is the invariant**: `parseSeedFromDescription(buildIssueDescription(seed))` must
  return exactly `seed`. Two rules protect it — **no schema default values**, and no field the
  widget cannot rebuild from what is stored. Adding a default is the easy way to break this
  silently; the test `adds no field the caller did not provide` is there to catch it.
- **Bump `SEED_VERSION`** when the payload shape changes — it is `2` since SKG-498 added
  `reporter.verified`. Readers accept older versions and refuse
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
  now happened **four** times, twice while writing a comment about a different bug; the failure
  is loud — the module will not load — but the cause reads as a mystery until you look at the right
  line. Write `display:block`, not the same thing in backticks.
- Comments explain _why_, not _what_ — the tolerant parser and the redundant anchor both exist for
  reasons that are not obvious from the code.
- Work is tracked in Linear on the
  [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team SKG).
  Reference tickets as `SKG-xxx` in commits.

## Linear MCP

The Linear MCP server is declared in [.mcp.json](.mcp.json) at the project scope. If its tools are
missing in a session, it needs to be approved and authorized (`/mcp` in an interactive session) —
it cannot be authorized from a non-interactive one.
