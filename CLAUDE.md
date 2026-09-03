# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

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

- **`FRUITBACK_STORE=memory` swaps the real Linear for `linear-memory.ts`**, so the whole loop —
  capture, issue, pins coloured by state — runs with no API key and writes to nobody's workspace. It
  is refused under `NODE_ENV=production` (which the Dockerfile sets), `/health` answers
  `{ ok: true, store: 'memory' }`, and the boot log says so. `FRUITBACK_FAKE_LINEAR=1` is the older
  spelling and still works — see *Which store, and who validates it*. It is **not** a mock: an issue is
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
- **Bundling them makes their MIT notices our obligation** (SKG-515). MIT asks the notice to travel
  with the code, and both are compiled into `dist`. Measured: `react-grab` carries `@license` banners
  esbuild preserves — four survive into the bundle — and **`zod` carries none**, so its notice
  reaches a consumer through `packages/widget/THIRD-PARTY-NOTICES.md` or not at all. `packages/shared`
  is compiled by `tsc` rather than bundled, keeps `zod` as an ordinary dependency, and owes nothing.

## Licences

- **MIT on the three published packages, AGPL-3.0-only on the worker** (SKG-515). The split follows
  the client/server boundary: the widget is compiled into someone else's site, and copyleft on code
  that ships inside a client's bundle is a licence nobody adopts. The worker is the server, which is
  the only place copyleft bites.
- All three shipped as `UNLICENSED` until this ticket, which is worse than unpublished: a package with
  no licence is one nobody may legally use.
- **The guard asserts the `license` field and the LICENSE text, not the presence of a file** — and
  that is not fussiness, it is what two measurements forced. npm **force-includes** a `LICENSE`
  whatever `files` says, and pnpm **copies the workspace root's LICENSE** into any package that has
  none of its own. So "the tarball contains a file called LICENSE" is true even for a package that
  never declared one. `"LICENSE"` in `files` is documentation, not the mechanism.
- `THIRD-PARTY-NOTICES.md` is the opposite case: npm force-includes nothing by that name, so its
  `files` entry **is** load-bearing. Dropping it was measured failing the guard.
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

## The look, and the one thing a host may change

- **`theme.ts` owns every colour, shadow, font family and duration** (SKG-528). They were
  hexadecimals spread across five `STYLES` literals — `host.ts`, `overlay.ts`, `composer.ts`,
  `panel.ts`, `orphans.ts` — plus the stage colours, which travelled in the *published contract*.
- **Custom properties, because inheritance is what crosses the modules.** Each module injects its own
  `<style>` into the one Shadow root, so a token on `:host` reaches all of them with nobody importing
  anything. `THEME_STYLES` is concatenated ahead of `host.ts`'s reset for that reason.
- **The prefix is `--fruitback-`, and it is the whole defence.** A custom property inherits *into* the
  Shadow root from the client's page — the root blocks their selectors, never their inherited
  properties — so a name the host also uses repaints our widget silently. `--color-text` would be
  reckless, and `--fb-` no better: it is what a Facebook SDK or somebody's flexbox utilities would
  plausibly pick.

## One prefix, and it is `fruitback`

- **`--fruitback-*` tokens, `.fruitback-*` classes, `data-fruitback-*` attributes.** One word
  everywhere (SKG-580), including the names on the `<script>` tag the README documents.
- **It took three goes, and the reason it landed here is worth keeping.** `--fb-` was reckless for a
  property that inherits into a Shadow root. `--fruit-` fixed that and introduced a subtler problem:
  the repo then had `--fruit-`, `.fruit-`, *and* `data-fruitback-` on the script tag, and an
  intermediate prefix reads as an inconsistency, not as a tier. A rule a newcomer has to be told is a
  rule that will be broken. One word is a rule nobody has to be told.
- **The distinction it collapses was real but not worth its cost.** `data-fruitback-endpoint` sits in
  someone else's DOM and `data-fruitback-pin` sits in our Shadow root, and one could argue those
  deserve different spellings. Nobody reading the code would have inferred which was which, so what
  the two prefixes actually bought was a question every reader has to answer twice.
- **The failure mode of these renames is silent**, which is why `pnpm e2e` is the proof and the unit
  tests are not: the JavaScript writes one name, the stylesheet reads another, and a pin renders with
  no colour and no error anywhere.
- **The DOM camelCases, and that is where a rename hides.** `data-fruitback-pin` is written
  `dataset.fruitbackPin`, with no hyphen, so a pass over the kebab spelling misses every one of them
  — 32 in this package. Renaming the stylesheet without the JavaScript that sets the attribute turned
  25 unit tests red on the first attempt, which is the loud version of exactly the failure above.
- **`--fb-` and `--fruit-` survive in the prose above, and only there.** They are the history that
  explains the current name; the first pass of SKG-580 spared them mechanically and left a paragraph
  describing a distinction the code had stopped making, which is the worse failure — a comment that
  outlives what it described.
- **`init({ theme })` takes tokens, never CSS.** A host that could write a stylesheet into the Shadow
  root would turn our class names into a contract by accident, which is what the Shadow root exists
  to prevent. `applyTheme` writes only names `THEME_TOKENS` declares and silently drops the rest, so
  a token renamed in a later version costs that override and never the mount.
- **`public.ts` exports the theme *types* and not `THEME_TOKENS`.** The runtime array would widen the
  published surface; `package.test.ts`'s `promises only what public.ts declares` caught that on the
  first attempt, which is what it is for.
- **The base `:host` block must declare every settable token**, and the test that checks it is scoped
  to that block. Searching the whole stylesheet passed a mutation that deleted a declaration, because
  the dark block redeclares it — a token declared only under `prefers-color-scheme: dark` is undefined
  in light mode.
- **Radii are not tokenised, on purpose.** Eight distinct values are in use and each would map to
  exactly one token: indirection wearing the costume of a scale, and more for SKG-529 to undo when it
  shortens the scale deliberately. Spacing likewise — nobody overrides it, and substituting sixty
  literals is where a silent visual regression hides.
- SKG-528 changed **no colour**: every token holds the hexadecimal that was already there, and
  `e2e/overlay.spec.ts`'s computed-colour read is the proof. One shadow moved 4px, because the thread
  and the panel spelled the same intention two ways.

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
  that width. The anchored position goes through `--fruitback-composer-*` custom properties rather than
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

## The optional picture

- **The widget does not bundle a rasteriser** (SKG-495). `captureScreenshot` is a seam the embedder
  fills, for two reasons that each stand alone: the seed contract stores a **URL**, so the image has
  to live in someone's storage, and html2canvas weighs more than this entire widget — bundling it
  would break `package.test.ts`'s 150 kB tripwire and the promise that tripwire guards.
- **Off by default, and the toggle is absent unless `captureScreenshot` was given.** A switch that
  controls nothing is what kept this setting out of SKG-503.
- **A capture that throws costs the picture and never the note.** A canvas tainted by a cross-origin
  image is the ordinary outcome, not the exotic one; the E2E test for this fails by losing the note
  entirely when the guard is removed.
- The flow past the setting is **E2E-only**: `init` resolves what was clicked through react-grab's
  hit testing, which happy-dom has no `elementsFromPoint` for. The unit tests stop at the toggle and
  say so rather than asserting negatives that would hold even if nothing ran.

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
  (`FRUITBACK_HIDE_COMMENTS=1`). Under `read: 'public'` it is the only thing between an issue thread
  and anyone who can load the client's page; under `read: 'authenticated'` (SKG-533) it is back to
  being the editorial choice it should always have been, because the reader is someone the worker
  checked.

## Who may read a pin

- **`GET /feedback` used to answer anyone who could build the URL.** Every note, its author and the
  team's replies were readable by any visitor of the client's site, and by `curl` — which is why
  hiding pins in the browser was never the fix. `read: 'public' | 'authenticated'` is (SKG-533), per
  client in `FRUITBACK_CLIENTS` or worker-wide via `FRUITBACK_READ`.
- **The extension is a different problem.** It settles *visibility* — the pins leave the visitor's
  DOM. It settles nothing about *authorisation*: the endpoint stays open and `curl` still works.
  Building SKG-534 without this ticket hides the comments in the UI and leaves them in the API.
- **`authorizeRead` runs before `cached`, and the guard is `stub.calls`, not the status code.** A
  gate moved below the cache still returns `401`, so asserting the status cannot tell the two apart
  — it was measured passing against exactly that mutation. What it costs is a Linear call per
  unauthorised request, so the test that pins the position asserts **no call reached Linear**. The
  warm-cache test is a narrower guard: it catches a cache-hit fast path that answers before the gate.
- **`public` stays the default, and that is compatibility rather than security.** Defaulting to
  `authenticated` would blank the pins on every upgraded worker with no error anywhere, and the
  operator would hear about it from users. The exposure is made *sayable* instead: the boot log names
  every client whose pins anyone can read, `/health` counts them. Loud beats silent both ways.
- **`/health` carries a count, never the ids.** It needs no authentication either, so listing client
  ids would hand over the map the worker serves. The boot log names them, where only an operator looks.
- **A client that requires a token and has no key to check one is refused at boot.** The trap is
  inheritance: `read` is inherited from the worker-wide default, `identitySecret` deliberately never
  is, so flipping `FRUITBACK_READ` can make a client unreadable without its own entry changing.
  `unreadableClients` names them; the alternative is a permanent `401` that looks like a broken widget.
- **A `401` on a read leaves the pins where they are.** Same rule as an unreachable worker: losing
  what is correctly on screen reads as "my notes are gone". Mutation-tested — blanking on a failed
  read fails `embed.test.ts`.
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
  body, `429` rate-limited, `500` misconfigured, `502` `store-unavailable` (the widget should keep the
  note and retry), `401` the read needs an identity. `/health` answers `503` when misconfigured so a
  bad deploy is never routed to. **A code the widget reads is a promise**, so it names a role and
  never a vendor — `linear-unavailable` became `store-unavailable` with SKG-522 for that reason.

## Where a seed is stored

- **`store.ts` is the interface, and it existed before it was named** (SKG-522). `app.ts` used to
  select between the real and the in-memory module through
  `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>` — two methods, two
  implementations, an interface discovered by accident. `SeedStore` writes it down so SQLite
  (SKG-524) and GitHub (SKG-525) are implementations rather than new branches.
- **`findForPage` states the intention, not the method.** Linear filters server-side with
  `description: { contains: … }`, GitHub searches bodies, SQL does a `WHERE`, and a store with no
  search would walk everything. Exposing a `contains` filter on the interface would have made
  Linear's trick the contract.
- **The old `Routing` mixed two things, and the split is the point.** `ClientPolicy` — `showComments`,
  `identitySecret`, `read` — is what the *worker* decided, whatever store is behind it. `teamId` and
  `projectId` went to `linear.ts`, where a team means something. `resolveClient` hands the client
  entry on whole, and **each store reads its own fields from it**.
- **`store.scope(client)` is what took `teamId` out of the read cache key.** The worker was building
  its key from `routing.teamId`, so the read path knew that stores route by team. Only the store
  knows what identifies a tenant — a team for Linear, an `owner/repo` for GitHub, nothing for a
  single-file SQLite. The client id stays in the key regardless, which is what keeps two clients
  sharing one team from sharing an entry.
- **`linear-memory.ts` is a `SeedStore` now but keeps importing `toSeedIssue` from the real
  connector, on purpose.** That coupling is the feature: an issue is stored as the description
  `buildIssueDescription` produces and read back through production's own mapping, so a broken round
  trip breaks the playground too. Renaming the file to something provider-agnostic would advertise an
  independence it should not have.
- **The store is built once per process, by the transport.** `createFruitbackServer` constructs it
  and every request gets it through `RequestContext`. It began as `storeFor(config)` inside the two
  handlers, which is invisible for Linear and the in-memory one — both stateless closures — and
  would have opened a SQLite connection per request the moment SKG-524 landed. Caught in review, not
  by a test, because nothing observable was wrong yet. The tests that hold it now assert the handler
  used the store it was **given**: a Linear stub left untouched is the proof it built none of its own.
## Which store, and who validates it

- **`FRUITBACK_STORE` selects the connector, and each connector validates its own environment**
  (SKG-526). SKG-522 named the interface but left the worker Linear-shaped anyway: `WorkerConfig`
  carried `linearApiKey`, `linearTeamId` and `linearProjectId`, so every module that could read the
  config could read one provider's credentials — and `readConfig` checked those three for **every**
  deployment, so a SQLite worker (SKG-524) would have been refused at boot for a missing Linear key.
- **What the worker keeps of a store is a name and a way to build one.** `StoreConfig` is
  `{ provider, create() }` and nothing else; a test asserts exactly those two keys, so the next
  provider's fields cannot arrive here either. `storeFor` is now one line.
- **`store-config.ts` is the mechanism, `stores.ts` is the registry**, and they are two files because
  the connectors import `defineStore` — holding the list in the same file would make it and
  `linear.ts` import each other. A new store is one entry in `STORE_SPECS`.
- **A store names its own environment variables.** `envNames` is required per field, so a boot
  diagnostic says `LINEAR_API_KEY` and never `apiKey` — mutation-tested, and the mutation also trips
  three older tests, which is how load-bearing that diagnostic is. `never reports a field name from
  any store` asks it of every spec rather than of Linear.
- **An unknown provider and a dev-only one in production are both refused, never defaulted.** A typo
  falling back to Linear would send a worker configured for SQLite to an API it has no key for; and
  feedback accepted into RAM behind a green health check is worse than a worker that will not start.
  That second guard is the one thing this ticket had to generalise without loosening.
- **`FRUITBACK_FAKE_LINEAR=1` still works, and it *degrades* where `FRUITBACK_STORE=memory` is
  refused.** The asymmetry is deliberate: a flag a container inherited must not stop it serving
  production, while a provider somebody deliberately named must not be silently swapped for another.
  So the sugar falls back to the real store and says so in the log; the explicit selection is refused
  at boot. `pnpm dev` and the E2E suite use the new spelling, which is what keeps the selection path
  exercised outside the unit tests.
- **`/health` answers `store: '<provider>'` instead of `fakeLinear: true`**, always. Which store a
  process runs on is exactly what an operator cannot tell from a green check, and naming one provider
  in the answer was the last place the endpoint assumed there was only ever one. Compared exactly in
  `app.test.ts`, on purpose: this endpoint is public, so a field appearing on it has to be written
  down.
- **A short `FRUITBACK_IDENTITY_SECRET` used to answer `missing:` and then nothing.** The field failed
  the schema, matched no entry in `NAMES_BY_FIELD`, and the list came back empty. Fixed in passing
  here, and `answers no empty diagnostic` walks every way of making the config invalid rather than the
  one that was noticed.
- **Still Linear-shaped in one place, and left there on purpose**: `apps/worker/src/linear-memory.ts`
  keeps its name and its import of `toSeedIssue`. See *Where a seed is stored* — that coupling is the
  feature.

## SQLite, and what a second connector actually proved

- **`sqlite.ts` is the connector that had to be uncomfortable** (SKG-524). One implementation of
  `SeedStore` proved nothing; GitHub Issues would have proved almost as little, since markdown bodies,
  labels and full-text search are Linear's shape under another name. SQLite shares none of it — no
  description, no `contains` filter, no labels, no workflow states.
- **It found exactly two places the interface leaked, and both were ours.** `SeedIssue.url` was
  required, and the only way to satisfy it was to invent a URL for a store with no web page; it is
  optional now. And the widget's thread said **"sur Linear"** — a vendor name in a widget that is not
  supposed to know which store answers, the same defect `store-unavailable` fixed in the error codes.
  Everything else fitted, which is the result the ticket was for.
- **`findForPage` gets to be a plain equality here**, where Linear can only filter by substring and
  re-checks afterwards. That is the payoff of naming the intention rather than the method.
- **The connection is shared per path, and the store object is not.** `handleRequest` still falls back
  to building a store when the transport did not hand it one, so without the shared handle that path
  opens a database per request — the hazard SKG-522 was written to prevent. The test asserts **how
  many handles were opened**, not `connections.size`: the map is keyed by path, so a `connect` that
  stopped reusing overwrites the entry and leaves the size at one. Both weaker spellings were measured
  passing against the mutation before this one was written.
- **There is nothing to project onto `SeedStage`.** The column *is* a stage, so `stageOf` only applies
  the contract's own tolerance — an unrecognised value colours the pin rather than hiding the note.
- **A row is parsed, never trusted.** The file sits on a volume an operator can edit and a restore can
  be older than the code. A malformed row costs that one pin; the page keeps its other notes.
- **`insert` and `select` are `async` so a failure to open the file rejects rather than throwing
  synchronously.** `connect` throws before any `await`, and `app.ts` happens to catch it either way —
  but a caller reaching for `.catch()` would have been bypassed on the one path that matters, a volume
  nobody mounted.
- **`sqlite3` is in the runtime image for one reason: the backup line in the README.** The store needs
  nothing installed; `.backup` needs a binary, and it is the only safe way to copy a live database.
  Measured in a container: `fruitback.db` was 4 KB while `fruitback.db-wal` held 53 KB, so a `cp`
  of the `.db` alone would have lost the note that had just been planted.
- **Verified in the container, not only in `node --test`**: boot on `FRUITBACK_STORE=sqlite`, `/health`
  answering `store: sqlite`, a seed posted and read back, the pin surviving `docker restart`, and the
  documented backup command producing a file that holds the seed.
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
- Pin colour comes from a `SeedStage`, and the widget never stores a status of its own — it renders
  the one the store reports.
- **The stage vocabulary is the contract's; the projection onto it is the connector's** (SKG-516).
  `SEED_STAGES` and `DEFAULT_SEED_STAGE` live in `shared`; `stageForLinearState` and
  `LINEAR_STATE_TYPES` moved to `apps/worker/src/linear.ts`, where Linear's vocabulary belongs.
  Naming one provider's states in the contract made every consumer of the published package depend
  on that provider, and GitHub's projection — two states plus labels — will not resemble Linear's.
- The fallback for an unrecognised state stays in `shared` on purpose. A connector spelling
  `'seeded'` itself is how the next one comes to disagree, and an unknown state must colour the pin
  rather than hide someone's note.

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
  `composer.ts`, `panel.ts`, `orphans.ts`, and `THEME_STYLES` in `theme.ts`). A comment quoting a
  symbol closes the literal and the file stops parsing. It has now happened **five** times — twice
  while writing a comment about a different bug, and the fifth inside the paragraph of `theme.ts`
  that forbids it, three lines below the warning. Write `display:block`, not the same thing in
  backticks.
- **The test that greps for a backtick guards the quiet half only.** An odd number stops the module
  parsing, so no test in that file can run — loud, but the cause reads as a mystery. What the
  assertion catches is an even number: it parses, and silently truncates the stylesheet.
- Comments explain _why_, not _what_ — the tolerant parser and the redundant anchor both exist for
  reasons that are not obvious from the code.
- Work is tracked in Linear on the
  [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team SKG).
  Reference tickets as `SKG-xxx` in commits.

## Linear MCP

The Linear MCP server is declared in [.mcp.json](.mcp.json) at the project scope. If its tools are
missing in a session, it needs to be approved and authorized (`/mcp` in an interactive session) —
it cannot be authorized from a non-interactive one.
