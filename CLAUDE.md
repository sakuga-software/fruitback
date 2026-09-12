# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

**It is loaded into every session; `docs/` is not.** So what is here is what an agent has to know
before it writes a line — the conventions, the invariants, and the traps that bite silently. The
measurements behind each decision, and the per-ticket histories, live in
[docs/decisions/](docs/decisions/) and are there to be read on demand. Each section below ends with
the link to its own.

## Project

Fruitback is a visual feedback widget: a client clicks an element on their staging site, writes a
note, and it becomes an issue carrying the CSS selector, the React component and the source file.
Coming back to the page, they see their pins again, coloured by that issue's status.

**Status, threads, assignees and history belong to the store**, never to a second model kept in step
with it. Every store the worker speaks to is one somebody already runs: Linear is the default and
the richest of them, and `FRUITBACK_STORE=sqlite` is the door for a self-hoster who wants no third
party. Fruitback does not reinvent issue tracking, and since SKG-524 it no longer requires somebody
else's account either. See [docs/architecture.md](docs/architecture.md) for the alternatives that
were dropped.

**Deployment is Docker on a VPS, driven by Dokploy from GitHub** — no Cloudflare, no serverless, no
managed platform primitives. When something needs infrastructure, reach for what a single container
behind Traefik can do.

**Deeper** — *Project*, *Layout*, and what this file said about itself before SKG-524:
[docs/decisions/project.md](docs/decisions/project.md).

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
- `packages/widget` (`@fruitback/widget`) — the browser half, and the whole of it: capture
  (`captureSeed`), the overlay (`resolveAnchor` + `createOverlay`), the Shadow DOM host
  (`createCaptureHost`), the note popover (`createComposer`) and the settings panel.
- `packages/fruitback` — the front door a client installs. It re-exports the two above and defines
  nothing.
- `apps/worker` (`@fruitback/worker`) — the Node service. `POST /feedback` plants a seed,
  `GET /feedback?url=…` returns the seeds of that page. Still called "worker" because that is what
  everyone calls it, though it is no longer an edge worker.
- `apps/extension` — the browser extension (SKG-534): the widget on a site that embeds nothing.
- `apps/playground` (`@fruitback/playground`) — the dev loop: a deliberately hostile fake client site
  with the widget mounted on it, built as a React Router 8 + Vite app with HeroUI because the
  widget's clients are React apps. Not shipped, not deployed.

## The dev loop

**`pnpm dev` starts both halves. The ports are fixed, and these are them:**

| | |
| --- | --- |
| `http://localhost:5177` | the playground page |
| `http://localhost:8788` | the worker, on its in-memory Linear |

`8788` and not `8080`: 8080 is the container's port, and something is usually already sitting on it
on a developer's machine. `/tf` and `/tfp` read these numbers from here rather than probing.

- **`FRUITBACK_STORE=memory` swaps the real Linear for `linear-memory.ts`**, so the whole loop runs
  with no API key and writes to nobody's workspace. It is refused under `NODE_ENV=production`, and
  `/health` answers `{ ok: true, store: 'memory' }`. It is **not** a mock: an issue is stored as the
  description `buildIssueDescription` produces and read back through production's own `toSeedIssue`,
  so a broken round trip breaks the playground too.
- The playground's toolbar and `fruitback.tsx` are **scaffolding, not the product**. Do not grow
  features there; grow them in `packages/widget`. `fruitback.tsx` only *reports* what the widget
  decided, through `onResolve` — a client's app cannot know when to re-resolve, so the widget must.
- `apps/playground/.react-router/` is typegen, regenerated on dev and build. Ignored, not committed.

**Deeper** — *The dev loop*, and why the playground is a React app:
[docs/decisions/dev-loop.md](docs/decisions/dev-loop.md).

## The E2E suite

`pnpm e2e` (Playwright, `e2e/`) starts both servers itself and runs its specs against Chromium. It
builds `dist` first, because `package.spec.ts` loads the real file.

- It exists for the two things happy-dom cannot vouch for: a **real selector engine** and **real
  layout**. Everything else stays in `node --test`, which is where it is faster and clearer.
- Specs share one worker process, so each captures on **its own page URL** (`/?case=…`) — the seed's
  page identity is what keeps them apart. There is no reset between specs.
- **Assert on what you measured, never on a second measurement.** Poll until a value satisfies the
  check and keep *that* value: a computed colour read mid-transition is the interpolated one (which
  Chromium serializes in another colour space), and the composer clears its confirmation 1.1s after
  showing it. Synchronise on the harness's status line rather than on a pin count — the old pins are
  still in the DOM while the new set is being fetched, so counting races.
- **A cold Vite cache is the difference between your machine and CI.** The guarantee is
  `e2e/warm-up.ts`, a `globalSetup`; `optimizeDeps.include` is not enough on its own. Reproduce the
  CI condition with `rm -rf apps/playground/node_modules/.vite`.

**Deeper** — *The E2E suite*, the `504 (Outdated Optimize Dep)` mechanism and the four defects this
suite has caught: [docs/decisions/dev-loop.md](docs/decisions/dev-loop.md).

## The published package

- **Three packages, and only one of them is the front door.** `fruitback` re-exports the two scoped
  ones and **defines nothing** — anything declared there rather than forwarded is a third place for
  the contract to drift. It is not bundled either, so there is one copy of the widget on disk.
- **`public.ts` is the contract, `index.ts` is the workspace.** Everything is exported somewhere
  because the playground and the tests reach into the parts; only what `public.ts` names cannot
  change without a major version. `init` and what it hands back is all of it — deliberately **not**
  the config store, which would be a preference we could never change under a host.
- **`embed.ts` is the only file that knows the worker exists.** `composer.ts` is handed an
  `onSubmit`; the transport lives in the assembly layer.
- **`init` patches `history.pushState`/`replaceState`** and restores them on `destroy`. A pin belongs
  to a URL, `popstate` does not fire for a `pushState`, and there is no framework to ask on a
  client's site.
- **The `workspace` fields point at source; `publishConfig` swaps in `dist` when pnpm packs. All
  three packages need `prepack`.** Miss either and the tarball ships `src` while `publishConfig`
  points at a `dist` that is not there — a failure that lands in a consumer's build and nowhere here.
- **`rewriteRelativeImportExtensions` rewrites the JavaScript and not the declarations.** Both builds
  therefore post-process their `.d.ts` and then assert no `.ts` extension survived.
- **The guard that matters is `package.test.ts`'s `type-checks an import with no special tsconfig`.**
  It deletes every `dist`, packs all three, asserts each tarball contains one, installs them into a
  scratch project and type-checks an import from **each** package, with `skipLibCheck` **off**. Every
  clause is there because something without it shipped green. **Read the file after editing this
  guard**: two of those clauses were described here, and in a PR reply, while the edit that would
  have added them had silently not applied.
- `react-grab` and `zod` are **bundled, and are devDependencies** — a client site must not have to
  install, or resolve a version conflict over, a library it never asked for. Bundling makes their MIT
  notices our obligation (SKG-515), and `packages/widget/THIRD-PARTY-NOTICES.md` is how they travel.
  Phosphor is in there for the same reason by a different route: two of its paths are compiled in.
- **93 kB gzipped, guarded by a test that trips at 150 kB** — a tripwire for a dependency that should
  have been bundled out, not a budget.

**Deeper** — *The published package*: [docs/decisions/packaging.md](docs/decisions/packaging.md).

## Licences

- **MIT on the three published packages, AGPL-3.0-only on the worker** (SKG-515). The split follows
  the client/server boundary: the widget is compiled into someone else's site, and copyleft on code
  that ships inside a client's bundle is a licence nobody adopts.
- **The guard asserts the `license` field and the LICENSE text, not the presence of a file.** npm
  force-includes a `LICENSE` whatever `files` says, and pnpm copies the workspace root's into any
  package with none of its own — so "the tarball contains a LICENSE" is true even for a package that
  never declared one. `THIRD-PARTY-NOTICES.md` is the opposite case: nothing force-includes it, so
  its `files` entry **is** load-bearing.
- **The README snippet is read from the README and checked against the build** (`package.test.ts`,
  SKG-519). Every `data-fruitback-*` attribute the landing page tells a reader to write must be one
  the built script actually reads. Before that, the claim in this file was an overclaim: the test
  asserted the *build* named one attribute and nothing had ever opened the file a reader copies from,
  so a renamed attribute left the landing page quietly wrong with a green suite. The built global is
  separately *executed* on a real page by `e2e/package.spec.ts`.

**Deeper** — *Licences*: [docs/decisions/packaging.md](docs/decisions/packaging.md).

## The widget

**Capture**

- **`captureSeed` is the only place a seed is built**, and it goes through `createSeed` — so a
  malformed anchor fails in the reporter's browser instead of as a `400` after the note was typed.
- The anchor is deliberately redundant — selector, `domPath`, text, attrs, bounds — because the site
  will be redeployed between writing the note and reading it. `selector.ts` does not answer "what
  selects this element" but **"what still selects it next week"**: test ids and author-written ids
  win, a `useId` `:r7:` and a CSS-modules class are refused, and whatever comes out is verified
  unique against the document. When nothing identifies an element that repeats, the selector is
  **scoped under the nearest identifiable ancestor** rather than pathed from `<html>`.
- `page.url` is canonicalized here too, which is what makes the widget query the read path with the
  key its seeds were stored under.
- **react-grab owns `source`, but only field by field.** `captureSeed({ source })` wins per field and
  `readReactSource` fills the gaps. Merging rather than choosing is not tidiness: on a design system
  react-grab gets `file`/`line` right and the component name wrong.
- **A component name a bundler minted is worse than none.** `isMangledComponentName` drops them and
  the walk continues to the first name a human wrote. It deliberately does **not** climb to the app's
  own component.
- **The owner chain ends in `null`, not `undefined`.** Both walks stop on either. Checking only for
  `undefined` dereferences the root, throws out of `captureSeed`, and a click silently stops planting
  anything.

**The Shadow root**

- `createCaptureHost` owns the widget's DOM. **A Shadow root is the only version of "no style
  conflicts" that survives a real client site** — neither direction is achievable with prefixed class
  names.
- `:host { all: initial }`, because a Shadow root blocks the page's *selectors* but not its
  **inherited** properties. Three consequences, all of them load-bearing:
  - `style, script { display: none }` — `all: initial` undoes the browser's own rule and renders the
    stylesheet as visible text on the client's page.
  - `display` is restored at the reset in `host.ts` — every block element is otherwise inline, and
    vertical margins on it silently do nothing.
  - the reset is `*:not(svg, svg *)`. Since SVG2 a path's geometry is a CSS property, so a bare star
    computes `d: none` and every icon renders as an empty box, with nothing in the console and
    nothing a unit test can see.
- **The host sits at the document origin, absolutely positioned, with no size.** The overlay places
  pins in document coordinates; move or offset the host and every pin moves with it.
- **`engine.ts` is the whole surface we take from react-grab**: hit testing across shadow roots and
  iframes, viewport bounds, source context. Three functions behind an interface, so the unit tests
  hand over a fake — happy-dom has neither `elementsFromPoint` nor layout.
- **Hit testing has to be told to ignore us.** `ignore` extends that to chrome the *page* mounts
  around the widget.
- **Never `instanceof Element` in this package.** It reads a class off one realm, and an element from
  a same-origin iframe — which react-grab returns on purpose — belongs to another. Use `isElement`
  from `dom.ts`.

**One prefix, and it is `fruitback`**

- **`--fruitback-*` tokens, `.fruitback-*` classes, `data-fruitback-*` attributes** (SKG-580). One
  word everywhere, including on the `<script>` tag the README documents. A custom property inherits
  *into* the Shadow root, so a name the host also uses repaints our widget silently: `--fb-` would be
  what a Facebook SDK picks, and an intermediate `--fruit-` reads as an inconsistency rather than a
  tier. A rule a newcomer has to be told is a rule that will be broken.
- **The failure mode of these renames is silent**, which is why `pnpm e2e` is the proof and the unit
  tests are not: the JavaScript writes one name, the stylesheet reads another, and a pin renders with
  no colour and no error anywhere. **The DOM camelCases**, so a pass over the kebab spelling misses
  every `dataset.fruitbackPin`.
- **`theme.ts` owns every colour, shadow, radius, font family and duration.** Each module injects its
  own `<style>` into the one Shadow root, so a token on `:host` reaches all of them. **The base
  `:host` block must declare every settable token** — a token declared only under
  `prefers-color-scheme: dark` is undefined in light mode, and the test that checks this is scoped to
  that block for exactly that reason.
- **`init({ theme })` takes tokens, never CSS.** A host that could write a stylesheet into the Shadow
  root would turn our class names into a contract by accident. `applyTheme` writes only names
  `THEME_TOKENS` declares and silently drops the rest.
- **`public.ts` exports the theme *types* and not `THEME_TOKENS`.** The runtime array would widen the
  published surface.
- The pin's silhouette is **not** in the radius scale: `border-radius: 50% 50% 50% 0` is a shape, not
  a corner size. Spacing is still literal on purpose.

**No emoji**

- **Nothing in `packages/widget` renders an emoji** (SKG-529). An emoji is drawn by the system's own
  font: the same codepoint is flat on Windows and glossy on macOS, it takes no colour, and it carries
  a register that cannot be dialled down. `icons.ts` holds the four glyphs, built with
  `createElementNS`, sized in `em`, painted in `currentColor`. An SVG assigned through `innerHTML` is
  parsed into the HTML namespace and renders nothing at all.
- **Paint travels as path attributes, not as CSS.** A `.fruitback-icon { fill: … }` rule beats
  Phosphor's own `fill="currentColor"` presentation attribute, and every imported icon renders wrong.
- **`icon-data.ts` is generated by `pnpm icons:build` and committed.** `icons.test.ts` asserts each
  committed `d` appears verbatim in the installed `@iconify-json/ph`. Iconify is a **source, never a
  runtime** — `iconify-icon` fetches its paths from a third party, from a client's page.
- **`≈`, `×` and `→` are not emoji.** They are typographic symbols with one drawing in every font.
- **A host's label is still the host's word**: the E2E specs mount with `label: '🌱 Feedback'` on
  purpose. Do not trust a count written here — run
  `grep -rnP "[\x{1F300}-\x{1FAFF}]" e2e` instead.

**The popover**

- **`createComposer` owns the states, not the transport.** `onSubmit` is awaited, so an embedder
  posts through whatever it set up while the widget stays ignorant of the worker's URL and of auth.
- The states are unit-tested because none of them can be seen by looking: the send button is disabled
  in flight (**a second click would plant the same note twice**, and the worker cannot tell), a
  failure keeps the popover open **with the text intact**, and a refusal (`onSubmit` resolving
  `false`) is treated as a failure rather than a success.
- **Losing what someone just wrote is the one failure this widget cannot afford.** Anything that
  would clear the field on an error path is a bug, however tidy it looks.
- Name and e-mail are optional, behind a disclosure, and never `verified` — that flag is the worker's
  to set.
- Popover on desktop, **sheet on a phone**. The anchored position goes through
  `--fruitback-composer-*` properties rather than inline `left`/`top`, because an inline style beats
  the media query and leaves the sheet offset.
- `prefers-reduced-motion` turns the animations **off**, here and on the pin.

**Who carries the calls**

- **`transport` is a seam, and it is the same one twice** (SKG-595): the widget stays dormant when a
  host has nothing to reach the worker with, and the extension relays the calls when it does.
  `TransportRequest` and `TransportResponse` are **plain objects, not `Request` and `Response`** —
  neither survives `postMessage`.
- **`transportFor` is one line and one place**, because a call site added later would otherwise take
  the default and leave a host's relay out of the loop with nothing to see. `embed.test.ts` reads the
  source and asserts no bare `fetch(` survives **and** that `fetchTransport` is named exactly twice.
  **That count includes comments** — do not name the default in a comment in that file.
- **Dormancy is not an option on `init`, it is not calling `init`.** `init` is synchronous and hands
  back a `ConfigPanel`; a site that wants the widget only for a reviewer waits for its transport and
  calls `init` then.
- **`fetchTransport` does not catch.** A worker nobody can reach rejects, and `embed.ts` treats a
  rejection and a failed status identically.

**The optional picture**

- **The widget does not bundle a rasteriser** (SKG-495). `captureScreenshot` is a seam the embedder
  fills: the seed contract stores a **URL**, and html2canvas weighs more than this entire widget.
- **Off by default, and the toggle is absent unless `captureScreenshot` was given.** A switch that
  controls nothing is worse than no switch.
- **A capture that throws costs the picture and never the note.** A canvas tainted by a cross-origin
  image is the ordinary outcome, not the exotic one.

**The settings panel**

- **What is not configurable is the design** (SKG-503). The Linear team, project and labels are
  absent: the client id is what the reporter can say, and what it routes to stays server-side.
- `config.ts` is the store, `panel.ts` the UI. It writes on every change, and **reading
  `localStorage` can throw** rather than return `null` — Safari in private browsing raises on the
  property itself.
- **The stored config is parsed like a seed**: tolerant, field by field. A malformed one costs the
  reporter their preferences, never the widget.
- **`createConfigStore({ pinned })` is what stops a stored value overriding the caller's.** The store
  restores its key from the page's own `localStorage`, so `endpoint` and `clientId` are pinned —
  otherwise a page that wrote the key first chooses where the notes go, and a preference already set
  beats a new default for ever.
- **Filtering lives in the overlay, not in the embedder.** `shouldShow` plus `refilter` redraw from
  the issues already held, so hiding a stage costs no request.
- **Do not use generic tags in the widget's chrome.** Playwright's selectors pierce open shadow
  roots, so a `<header>` in the panel made the page's own `header button` ambiguous.
- **Two elements must not share one accessible name.** The gear says `Ouvrir les réglages Fruitback`
  and the dialog `Réglages Fruitback`.

**Deeper** — in [docs/decisions/widget.md](docs/decisions/widget.md):
*The widget*, *The host, and why everything lives in one Shadow root*,
*The look, and the one thing a host may change*, *One prefix, and it is `fruitback`*,
*The popover*, *Who carries the calls*, *The optional picture*, *The settings panel*.
And *No emoji, and what replaced them* in [docs/decisions/icons.md](docs/decisions/icons.md).

## Re-anchoring, and why a pin says how sure it is

- `resolveAnchor` walks the anchor's claims in the order `SEED_ANCHOR_STRATEGIES` declares:
  **selector → testId → text → domPath → bounds**. That order is the contract's, and it puts `text`
  ahead of `domPath` deliberately.
- **Every match must be unique and of the captured tag**, and `domPath` must additionally still be
  roughly where the seed said it was — a structural path always resolves to *something*, and after an
  insertion that something is the neighbour.
- **`confident` is the field that matters.** `selector`, `testId` and `text` identify an element;
  `domPath` and `bounds` only locate a spot. A pin found by position is still placed, drawn dashed
  with a `≈`, and its thread says so. **Do not make the cascade stricter without reading
  `resolve.test.ts` first**: refusing outright throws away the many cases where position is right.
- **Detached is not the same as unsure** (SKG-501). `orphans.ts` lists only the notes where the
  cascade found **nothing** (`resolution.element === null`). The list is a sibling of the overlay's
  container, so **`isOurs` has to be told about it** — it was not, and rebuilding it on every resolve
  mutated the document, which scheduled another resolve. `orphans.owns` closes that loop.
- **`resolve()` is not `render()`.** `render` takes new data and rebuilds, which closes the thread;
  `resolve` keeps the pins and the open thread and only updates what was *found*, confidence marks
  included.
- **It watches the page, because nothing announces a re-render** (SKG-513). A `MutationObserver` on
  `childList`/`subtree`, debounced, plus a `ResizeObserver` per anchored element. Deliberately **not**
  `attributes`: a design system toggles classes on every hover, and what must be caught is the element
  being *replaced*.
- **Take `MutationObserver` and `ResizeObserver` off the document's own window**, never off
  `globalThis` — the same realm rule as `isElement`. Reading the global gets Node's, which has
  neither, and the widget then watches nothing at all, silently.
- The overlay positions in **document coordinates** and re-measures on scroll and resize.
- **Pins let clicks through**; only the badge is clickable. A widget that swallows the client's own
  buttons is one they turn off.
- Tests run against **happy-dom** (`dom.fixture.ts`), a devDependency of this package only. Nothing
  outside `*.test.ts` and `*.fixture.ts` may import it, and `tsconfig.json` excludes both so the
  shipped code still compiles with `types: []`.

**Deeper** — [docs/decisions/widget.md](docs/decisions/widget.md).

## The extension

SKG-539 names three modes: **public** (the site embeds the widget, everyone sees the pins),
**private** (the site embeds nothing and the extension injects the widget) and **équipe** (the site
embeds a dormant widget the extension activates and relays for). Private is SKG-534 and team is
SKG-596; both are built. Which one an origin is in is one field on its entry, and **an entry with no
`mode` reads as private** — that is every entry a reviewer's browser already holds.

- **`world: 'MAIN'` is the ticket, not a preference.** A content script in the isolated world shares
  the DOM and **not** the properties page scripts put on it: `__reactFiber$` and
  `__REACT_DEVTOOLS_GLOBAL_HOOK__` are both absent there, so the widget would mount, work, and quietly
  never say which component a note is about.
- **Registered as a content script rather than injected as a `<script>` tag.** A tag pointing at an
  extension URL is evaluated in the page and **the page's CSP can refuse it**.
- **No host permission at install.** `background.ts` registers the two scripts at runtime for the
  origins somebody turned on and granted, and unregisters them on the way out. `syncRegistration`
  unregisters on an empty set rather than updating — `updateContentScripts` refuses an empty
  `matches`, so an implementation that updated there would leave a switched-off site still running.
- **`packages/widget` is unchanged by this app, which is the ticket's own test.** The extension is a
  fourth assembler; nothing extension-shaped leaks into the widget.
- **The bridge is `window.postMessage`, and the page can forge on it.** `parseBridgeMessage` refuses
  a *malformed* message and cannot refuse a **well-formed** one the page wrote. That is inherent to
  the main world and no handoff closes it — it is stated rather than defended, because a reviewer
  grants an origin precisely because they trust that origin's code. **Nothing secret travels there,
  and an identity token is not sent at all.** `worlds.test.ts` is what keeps that true, and
  `protocol.test.ts` pins that a parsed message carries only the four fields it declares.
- **`registerContentScripts` reaches the *next* page load, never the open one.** The popup injects
  both files into the current tab after the grant.
- **An unchanged decision is never re-posted**, because a re-posted `mount` destroys and rebuilds the
  widget, which closes the composer and loses what the reviewer was typing. The `ready` handshake
  forces past that comparison, because the page world may have missed the message.
- **`createApply` takes a generation token before its `await`.** Three things call it, two can be in
  flight, and the older read can post last. The `posted` signature alone made that **stick rather
  than heal**: the stale run writes its own signature and the correction is then suppressed as
  unchanged. The decision lives in `src/bridge.ts` and not in the entrypoint, because an entrypoint
  binds `browser` and `window` at import and neither guard could be run at all.
- **The endpoint is normalized before it is stored, and a path survives it.** `embed.ts` interpolates
  `${endpoint}/feedback?url=…`, so query and fragment go, a trailing slash goes, and the **path
  stays** — a worker behind `https://example.com/fruitback` is an ordinary Traefik deployment.
- **A site that embeds the widget *and* a reviewer who has the extension get two docks.** Known,
  harmless, and not solved here. It is the private mode's defect only: in team mode there is one
  widget and it is the site's.

**The team mode** (SKG-596)

- **The main world announces instead of mounting.** `page.content.ts` puts
  `window.fruitbackExtension = { version, transport }` on the page and fires `fruitback:extension`.
  Two ways to find it because nothing orders a content script against a site's own bundle.
- **Installing the API is idempotent, which is what makes the event safe to mount on.** The global is
  set and the event fired only when the global is not already ours, so a re-posted decision announces
  nothing. **Withdrawal is the same event with the global gone** — nothing here can destroy a widget
  the site owns, so a site switched off would otherwise keep stale pins and a composer that fails
  silently.
- **`clientId` and the widget's endpoint come from the site.** The stored entry carries an endpoint
  anyway, and it is not what the widget is pointed at: it is what the relay checks the page's
  declaration against.
- **The relay is the mode.** Without it this is decluttering: a page can forge the presence signal,
  and `curl` still reads a worker left at `read: 'public'`. It has security value **only** on
  `read: 'authenticated'` (SKG-533, which is built). Do not describe the mode as a guarantee
  without naming that setting.
- **Every decision the relay makes is in the background, and `src/relay.ts` holds all of them.** A
  content script's own input is written by the page, so the isolated world carries the request
  across and decides nothing. The origin comes from `sender`, never from the message; the endpoint
  from storage; the credential from the session.
- **A page that names another worker is refused, never redirected.** A reviewer holds a session per
  worker, so a page free to choose the endpoint could be answered with their credential for a
  worker nobody on that page chose. Relaying to the stored endpoint instead would be worse: the
  widget would report success against a worker it never named.
- **No session, no call, and no plain `http://` either.** Relaying without the header would work on a
  `read: 'public'` worker, and a reviewer would never learn they are unpaired while the mode
  delivered none of what it promises. The endpoint must be https or loopback, because the token is a
  bearer credential and this is the only thing carrying it; the popup refuses a team entry and
  disables pairing on the same rule. **`isWorkerEndpoint` is not tightened** — it gates the private
  mode's mount, which carries no credential.
- **`Authorization` is built in the background and `Content-Type` is the only header the page may
  name.** `ALLOWED_HEADERS` in `protocol.ts` is an allowlist of one, and `relay.ts` writes the
  credential name by name rather than spreading — two spellings of one header reach `fetch` as a
  combined value.
- **One path, `/feedback`.** `relay.test.ts` reads `packages/widget/src/embed.ts` and asserts the
  widget calls that path and names no header the relay would drop, so a call the widget grows later
  fails the suite instead of being dropped silently on a reviewer's page.
- **Two deadlines, and the shorter one aborts.** The composer disables its send button in flight, so
  a promise that never settles leaves a reviewer with a dead button and a written note inside it.
  `RELAY_CALL_TIMEOUT_MS` aborts the background fetch — merely giving up would leave the request in
  flight while the page is told it failed, and a second send plants the note twice.
  `RELAY_ANSWER_TIMEOUT_MS` is longer, so a slow worker is a refusal the background sends rather than
  a timeout the page invents. **`createRelay` never rejects**, because a rejection leaves the
  background with nothing to answer the runtime message with.
- **`relay-transport.ts` exists so `node --test` can reach the correlation**: the widget reads and
  writes independently, so two calls are in flight in the ordinary case. Its ids come from
  `randomId`, not `crypto.randomUUID` — that one needs a **secure context** and this script runs on
  `http://` staging too. `capture.ts` already carried the same fallback for the seed id, and the trap
  was walked back into here.
- **An extension origin is exempt from `ALLOWED_ORIGINS` on every route, by scheme.** The relay
  calls `/feedback` from the service worker, which sends `chrome-extension://<id>`. See the worker
  section below.

**The session** (SKG-599, the extension half of SKG-535)

- **The refresh token lives in `chrome.storage.local` and the access token in
  `chrome.storage.session`.** One survives the browser closing and the other must not. Both in
  `session` would make a reviewer pair again every morning, and somebody who does that keeps their
  pairing code in a text file — a worse place than the one the split protects.
- **Nothing calls `setAccessLevel` on the session area.** Its default excludes content scripts, which
  is the boundary this whole batch exists to hold. A token is held only by the extension's **trusted
  contexts** — the background, which refreshes, and the popup, which pairs and logs out. The isolated
  script never reads one; it asks the background to make the call, the seam SKG-596's relay needs.
- **Pairing asks for a host permission on the worker's origin**, which is not the site's. The session
  routes answer a `chrome-extension://` origin with CORS headers that ought to make an unprivileged
  `fetch` enough — but that was measured with `curl`, which does not enforce CORS. It is the
  repository's recurring defect (SKG-518) waiting to happen, so the permission is asked for rather
  than relied on. **It must be requested before anything is awaited in the click handler**, like
  `turnOn`: a gesture is lost across an await and the prompt never appears.
- **A refresh writes nothing back once the refresh token in storage is no longer the one it spent.**
  The popup and the background are separate contexts sharing only storage, so a logout can land while
  an alarm is awaiting `/session/refresh` — and the answer used to put a working access token back
  under a screen saying signed out. The token is its own generation marker; `chrome.storage` has no
  transaction, so the window is narrowed, not closed.
- **The guard is an allowlist**: `worlds.test.ts` *discovers* every `*.content.ts` declaring
  `world: 'MAIN'`, follows its relative imports, and refuses a `session*` module or the name
  `refreshToken` / `accessToken` anywhere in that closure. A main-world file added later is covered
  the day it is written. **It detects the world on the code, not on the file** — the docstring of
  `page.content.ts` quotes `world: 'MAIN'`, so the first version guarded a file that had stopped
  reaching the page and reported a pass.
- **No credential crosses plain `http://`** (SKG-596). `isSecureWorkerEndpoint` requires https or
  loopback, and `pair`, `refresh` and the revoke in `logout` all ask it — in `session.ts`, not only
  in the popup that warns first, so a session stored before the rule cannot keep spending its token
  over the wire. `isWorkerEndpoint` is **not** tightened: it gates the private mode's mount, which
  carries no credential.
- **`postJson` bounds its own request, and the reason is `serialize`.** The refresh chain runs one
  promise after the last, so a worker that accepts a connection and never answers wedges every later
  refresh for **every** worker, not just its own. Found by looking for the other half of a review
  finding about the relay's fetch.
- **Only a `401` ends a session.** An outage or a `502` keeps the refresh token: throwing it away on
  a network blip logs a reviewer out of a session the worker still considers open, and the only way
  back is an operator minting a new pairing code. For the same reason a `429` on `/session/pair`
  answers `unavailable` and never `code-spent-or-expired`.
- **Log out revokes, then clears — and clears whatever the revoke answered.** A failed revoke leaves
  the token live on the worker until it expires; a screen saying signed out over a working credential
  would be worse.
- `src/session.ts` is the logic behind seams and `src/session-browser.ts` binds the real
  `browser.storage` and `fetch`, the same split `bridge.ts` made. **Refreshing runs on an alarm, not
  a timer** — an MV3 service worker is stopped whenever the browser feels like it.
- **`nextWakeAt` never returns a moment in the past**, missing token included. It did, and the alarm
  was then clamped to a minute: a worker that stayed down woke the service worker to fail every
  minute, for ever. `isFresh` is the single freshness rule the three callers share so they cannot
  drift apart.

**Deeper** — *The extension, and the two worlds*, *The session, and the token that never goes down*
and *The team mode, and the call the page cannot make*:
[docs/decisions/extension.md](docs/decisions/extension.md).

## The worker

- It exists because a store's API key cannot ship in client-side JS — and, since SKG-524, because
  somebody has to hold the SQLite file too. **Resist putting logic here that belongs in the widget or
  in the store.** The rule is the point; "exactly one reason" was the wording until SKG-519, and it
  stopped being true when a store with no API key shipped.
- **`app.ts` is transport-agnostic** — a `handleRequest(request, env, context)` over web
  `Request`/`Response`. `server.ts` adapts `node:http` onto it and `main.ts` starts it. Keep new
  behaviour in `app.ts` so it stays testable without opening a socket.
- The env is validated up front (`readConfig`), so a missing secret surfaces at boot and on
  `/health`, not as an opaque error per request.
- **Both paths canonicalize the page URL** — `POST /feedback` re-does `seed.page.url` server-side and
  `GET /feedback` its `url` parameter. A client that skipped normalization would plant a pin nobody
  can find again.
- **The `description contains` filter is a substring match**, so `/pricing` also matches
  `/pricing?tab=annual`. `fetchSeedIssues` re-checks `seed.page.url` exactly before returning.
- The read cache (`cache.ts`) holds the in-flight promise, not the value. Failures are evicted at
  once: an outage must not be served for the whole TTL. In-process, therefore per replica — same
  caveat as the rate limiter, whose ceiling multiplies by the number of containers.
- Failure codes are deliberate: `400` the caller's fault, `403` origin not allowed, `413` oversized
  body, `429` rate-limited, `500` misconfigured, `502` `store-unavailable` (the widget should keep
  the note and retry), `401` the read needs an identity. `/health` answers `503` when misconfigured
  so a bad deploy is never routed to. **A code the widget reads is a promise**, so it names a role
  and never a vendor.

**Where a seed is stored**

- **`store.ts` is the interface.** `findForPage` states the *intention*, not the method — Linear
  filters by substring, SQL does a `WHERE`, and exposing a `contains` filter would have made
  Linear's trick the contract.
- **`store.scope(client)` is what keeps the read cache key store-agnostic.** Only the store knows
  what identifies a tenant. The client id stays in the key regardless, which is what stops two
  clients sharing one team from sharing an entry.
- **The store is built once per process, by the transport**, and every request gets it through
  `RequestContext`. Building it per handler would open a SQLite connection per request. The tests
  assert the handler used the store it was **given**.
- **`FRUITBACK_STORE` selects the connector, and each connector validates its own environment**
  (SKG-526). `StoreConfig` is `{ provider, create() }` and nothing else. A store **names its own
  environment variables** through `envNames`, so a boot diagnostic says `LINEAR_API_KEY` and never
  `apiKey`. `store-config.ts` is the mechanism, `stores.ts` the registry; a new store is one entry in
  `STORE_SPECS`.
- **An unknown provider and a dev-only one in production are both refused, never defaulted.**
  `FRUITBACK_FAKE_LINEAR=1` is the one exception and it *degrades* rather than refusing — a flag a
  container inherited must not stop it serving production, while a provider somebody deliberately
  named must not be silently swapped.
- **`/health` answers `store: '<provider>'`**, always, and it is compared exactly in `app.test.ts`
  because the endpoint is public.
- **A row is parsed, never trusted**, in every connector. A malformed one costs that pin; the page
  keeps its other notes. `sqlite.ts`'s `insert` and `select` are `async` so a failure to open the
  file rejects rather than throwing synchronously.
- **`linear-memory.ts` keeps its name and its import of `toSeedIssue` on purpose.** That coupling is
  the feature.

**Identity, and who may read a pin**

- **`reporter.verified` is the worker's word, never the client's** (SKG-498). Anything arriving with
  that flag has it stripped, whatever else it says.
- **`alg` is asserted against the token, never read from it.** A verifier that trusts the token's own
  algorithm accepts `alg: none` and validates everything. Anything but `HS256` is refused before a
  byte of the signature is looked at, and the signing input is `header.payload`.
- `exp` is **required** — a token that never expires is a password. Signatures are compared in
  constant time, because a `===` on the base64 leaks how much of it was right.
- **The identity token arrives in an `Authorization` header, never in the seed.** The seed is stored
  verbatim in a description anyone with workspace access can read.
- A token that fails to verify is a **401**, not a downgrade to anonymous. No token at all is fine
  and stays the default.
- **`read: 'public' | 'authenticated'`** (SKG-533), per client or worker-wide. `public` stays the
  default — that is compatibility, not security, and the exposure is made *sayable* instead: the boot
  log names every client whose pins anyone can read, and `/health` **counts** them without listing
  the ids.
- **`authorizeRead` runs before `cached`, and the guard is `stub.calls`, not the status code.** A
  gate moved below the cache still returns `401`.
- **A `401` on a read leaves the pins where they are.** Same rule as an unreachable worker: losing
  what is correctly on screen reads as "my notes are gone".
- **A comment body is `textContent`, never markup.** It is markdown written by anyone who can comment
  on the issue, rendered inside someone else's page.
- **Absent and empty mean different things** for `comments`: no field means the worker was not asked,
  `[]` means it asked and there were none. A client with replies switched off must not read as a team
  that never answered.

**Several client sites**

- **`FRUITBACK_CLIENTS` maps a `clientId` to a team, a project and the origins that client may be
  embedded on** (SKG-504). Configured, a client has to be named on **both** paths — the `client`
  parameter on a read, `seed.client.id` on a write — and an unknown one is refused. A read that named
  nobody used to answer with every seed on that URL.
- **`normalizeClientId` runs before the id is used for anything.** It picks the route, builds the
  `fruitback:<id>` label a read filters on, and keys the cache. Normalising it for the route alone
  put a note in the right team under a label its owner's clean read never asked for: authorised at
  both ends, invisible in between.
- **`clientId` is client-asserted.** `origins` is what turns the claim into something checkable
  against the browser's own header. Do not describe it as authentication.
- **`resolveClientIp` is security-relevant.** `X-Forwarded-For` is appended to by each proxy, so the
  client IP is the entry `TRUSTED_PROXY_HOPS` from the **right**. Reading the leftmost entry makes
  the rate limit bypassable with one header.

**The extension's session**

- **A session is credentials, and credentials are not seeds** (SKG-535). `FRUITBACK_SESSION_PATH` is
  its own SQLite file, whatever `FRUITBACK_STORE` says — a worker keeping its seeds in Linear still
  keeps its sessions on a disk it owns.
- **Do not reuse `sqlite.ts`'s `connect` for it.** That helper applies the *seeds* migrations and
  drives `PRAGMA user_version` with them, so a session database opened through it gets `seeds` and
  `comments` tables and two schemas fighting over one counter. `session-sqlite.ts` has its own.
- **The operator names the person; the browser never does.** A pairing code is minted *for* someone,
  carrying their name, and whoever redeems it gets a session that says so. An extension supplying its
  own name at pairing time is the browser asserting an identity, which is what SKG-498 closed.
- **The access token is an ordinary identity token**, signed with the same key `identity.ts`
  verifies. One verification path in this worker rather than two, and `read: 'authenticated'` accepts
  the extension with no change at all.
- **Pairing codes and refresh tokens are stored as SHA-256 digests.** A copy of the file must not be
  a set of working logins. A test reads the bytes SQLite wrote — the `-wal` file included, because a
  row just written is only there. **This is why a rotation cannot answer the same successor twice**,
  and it is what shaped SKG-600.
- **Every refresh rotates** (SKG-600). A refresh token that never changes is a thirty-day password.
  What retires a predecessor is its **successor being used** — proof the *token holder* received it,
  never proof of which holder, because a bearer token cannot say — not a clock.
  `ROTATION_GRACE_SECONDS` is the ceiling for an answer that was lost, measured from the **first**
  rotation, and derived from the extension's `REFRESH_MARGIN_MS + RETRY_DELAY_MS` by a test that
  reads them. Inside it the predecessor may be presented repeatedly; each retry replaces the
  successor nobody received, so one successor is live at a time. A token presented after its
  successor was used is a copy: the **whole chain** is revoked, and the caller gets the same `401`
  as for a token that never existed.
- **Rotation is a detection property, not a lifetime cap.** Do not write that a stolen token is
  useful for "at most one cycle" — three places said so and none was true. Whoever presents a bearer
  token is served, and inside the grace each presentation revokes the successor the one before it
  minted — so the **last** presenter keeps the chain and every earlier holder is locked out. Write
  *last*, not *first*: the inverted version shipped into three documents and a test name. What is
  guaranteed is only that the two cannot both keep the session quietly.
  `serves whoever presents last inside the grace, until the earlier holder comes back` holds it.
- **The successor inherits the predecessor's expiry.** Thirty days from pairing stays thirty days;
  rotation shortens what a leak is worth, it does not lengthen a session.
- **The replay test is the chain, not the row**, and `revokeSession` ends the chain. A revoked
  token presented while something in its chain is still live means two parties hold one chain: that
  is the signal, and everything goes. A chain with nothing live left is an ended session and answers
  `gone`. The earlier test — revoked *and* rotated — missed the case where a thief has the client's
  own successor revoked under it inside the grace, which left the thief refreshing for thirty days.
  The trade is that intercepting one answer in flight now ends the session at will; that capability
  already subsumes the attack. And a log out that revoked only the row it was handed left the
  successor of a lost-answer token live, held by nobody.
- **`rotated_at` marks the first rotation, never the last.** `AND rotated_at IS NULL` on that update
  is the grace being a ceiling: rewritten on every retry it slides, and whoever holds the token
  re-presents it just inside each window for ever.
- **One refresh in flight per endpoint** (`refreshOnce` in the extension's `session.ts`). Two callers
  spending the same token is a lockout, not a wasted request: the worker treats the second as a
  retry inside the grace, revokes the first successor, and whichever `keep()` lands last can leave
  the extension holding a revoked token. `background.ts` serialises the **alarm** only — the relay
  calls `ensureAccess` directly, and the widget has a read and a write in flight in the ordinary
  case. The lock is in `session.ts` and not the entrypoint, for the reason `bridge.ts` gives.
- **A `200` from `/session/refresh` with no `refreshToken` is not a success.** Taking it leaves a
  spent token in storage under a working access token, and the session dies when the grace runs out
  with nothing to explain it. Both call sites require the field; `parseIssued` stays tolerant.
- **`app.ts` builds the refresh answer field by field, so `refreshToken` has to be named there.**
  Leaving it out is what the route would do by default: the rotation works, the store holds the
  successor, and the client keeps sending a token the worker retired. `tsc` cannot see it and the
  extension's tests cannot either — they fake the worker. `session-routes.test.ts` asserts the body.
- **Minting a code is a command, not a route** (`node server.mjs pair --subject …`, and
  `server.mjs` because the image copies the bundle and no source). An endpoint
  would need an admin credential of its own and would stay reachable for ever; a command is reachable
  by whoever already sets the secrets.
- **An extension origin is exempt from `ALLOWED_ORIGINS`, on every route** (SKG-535, widened by
  SKG-596). That list names client *sites*; an extension's origin carries an id that differs between
  an unpacked build and a store build, so an operator cannot put it there. Measured: an MV3 service
  worker posting JSON sends `chrome-extension://<id>` and triggers a preflight, and both answered
  `403`. The `/session/` routes needed it first; the relay then called `/feedback` the same way.
  **`isExtensionOrigin` is one predicate in `cors.ts` that both gates ask** — `resolveCors` and
  `resolveClient` — because two copies of this rule would drift apart in silence. It is a list of
  schemes rather than "not http", so everything else falls through to the allowlist. It grants an
  extension what a caller with no `Origin` already has, and `read: 'authenticated'` is still what
  decides who may read.
- **`checkRateLimit` runs above the path dispatch**, so a route added later is metered by default. It
  used to sit below the `404`, which would have left `/session/pair` an unmetered guessing oracle.
  `/health` stays free — a readiness probe that can be rate-limited takes the container out.
- **Two boot refusals, both loud rather than silent.** A session path with no `FRUITBACK_IDENTITY_SECRET`
  mints nothing; a session path alongside `FRUITBACK_CLIENTS` mints tokens no client accepts, because
  a mapped worker ignores the worker-wide key.

**The markdown codec**

- **`markdown-description.ts` holds "put a seed in a markdown body and keep the issue readable"**
  (SKG-523). It is a strategy connectors **share**, not part of `SeedStore` — a store with columns
  must not have to implement a codec it has no use for, and `sqlite.ts` is the standing proof.
- **`pageQueryTerm` lives beside it**, because the term works only where `buildSeedBlock` writes the
  canonical URL verbatim into the JSON.
- `packages/shared/src/linear.ts` became `issue.ts`; `apps/worker/src/linear.ts` keeps its name,
  because over there a team really is Linear's.

**Deeper** — in [docs/decisions/worker.md](docs/decisions/worker.md):
*The worker*, *Who may read a pin*, *The team's replies*, *Where a seed is stored*,
*Which store, and who validates it*, *SQLite, and what a second connector actually proved*,
*The markdown codec, and the file that outlived its name*, *The extension's session*.
And *The published image* in [docs/decisions/image.md](docs/decisions/image.md).

## The published image

- **`ghcr.io/<owner>/fruitback-worker`** (SKG-540), for `linux/amd64` and `linux/arm64`. A Raspberry
  Pi and an ARM VPS are ordinary self-hosting.
- **The build stage is pinned to `--platform=$BUILDPLATFORM`.** It produces one bundled JavaScript
  file whose bytes are identical on every platform, so emulating the install and the bundle buys
  nothing. Only the runtime stage is emulated.
- **`latest` moves on a `v*` tag and never on a merge to `main`**; `main` publishes `edge`, and
  `sha-<commit>` is always written. **No tag is immutable**, `sha-<commit>` included — a tag names a
  commit, only a digest names a build.
- **Publishing is a second workflow, not a job in `ci.yml`.** A multi-platform build cannot be loaded
  into the daemon at all, and `ci.yml`'s `image` job is the only one that runs on a **pull request**.
- **`release-image.yml` checks every architecture it publishes, one job each, before anything is
  pushed** — and the check asserts the image *refuses* `FRUITBACK_STORE=memory`, matching the `503`
  and the **variable name**, never the prose beside it.
- **Trivy runs with `ignore-unfixed`**, and its action tag carries the `v` (`@v0.36.0`). One tag out
  of seventy-five is unprefixed, so the wrong form looks valid until the next bump.
- **`persist-credentials: false` on both checkouts** — this workflow's token carries
  `packages: write`, and `actions/checkout` otherwise writes it into `.git/config`.
- **Attaching the package is not publishing it.** A new package inherits the repository's visibility;
  making it public is a manual, one-time change in the package settings.

**Deeper** — [docs/decisions/image.md](docs/decisions/image.md).

## The seed contract

`packages/shared` is the contract both ends depend on. Treat changes to it as breaking.

- A **seed** is one pin: `note`, `page`, `viewport`, `anchor`, plus optional `source`, `client`,
  `reporter`, `env`, `screenshot`.
- **The round-trip is the invariant**: `parseSeedFromDescription(buildIssueDescription(seed))` must
  return exactly `seed`. Two rules protect it — **no schema default values**, and no field the widget
  cannot rebuild from what is stored. The test `adds no field the caller did not provide` is there
  because a default is the easy way to break this silently.
- **Bump `SEED_VERSION` when the payload shape changes** — it is `2` since SKG-498. Readers accept
  older versions and refuse newer ones (`unsupported-version`) rather than silently dropping fields.
- **`parseSeed*` never throws.** It returns `{ ok: false, reason }` — the input is a description a
  human may have edited.
- **`canonicalizePageUrl` is the page identity**: fragment and tracking params dropped, remaining
  params sorted. It must stay idempotent, and its output must appear **verbatim** in the description
  — that is what makes the `description: { contains: … }` filter work.
- **The contract holds the vocabulary and nothing a human reads** (SKG-517). No emoji, no English
  label, no colour: those are rendering decisions, and a published type is the one place they can
  never be changed or translated downstream.
- **The stage vocabulary is the contract's; the projection onto it is the connector's** (SKG-516).
  `SEED_STAGES` and `DEFAULT_SEED_STAGE` live in `shared`; `stageForLinearState` lives in
  `apps/worker/src/linear.ts`. The fallback for an unrecognised state stays in `shared` on purpose —
  an unknown state must colour the pin rather than hide someone's note.
- **`SEED_BLOCK_CAPTION` is free to reword.** `parseSeedFromDescription` iterates fenced blocks and
  recognises ours by parsing the JSON, and the test `finds the block by its JSON, never by the
  caption above it` is what keeps that true.

**Deeper** — [docs/decisions/contract.md](docs/decisions/contract.md).

## Conventions

- **Commit subjects and PR titles are Conventional Commits**: `type(scope): what changed (SKG-xxx)`.
  Types in use: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `ci`. The scope is the
  package — `worker`, `widget`, `shared`, `playground`, `extension` — and is omitted when the change
  spans them. A squash merge takes the PR title as the subject, so the **PR title** is the one that
  has to be well-formed.
  - **Do not infer this from the top of `git log`.** Three merges (#25, #26, #27) broke the pattern
    because a title was written by reading the most recent subjects, which were themselves the first
    two deviations. Twenty-four conventional merges sat underneath and went unread. The convention is
    written here so it is read here.
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
- **[SECURITY.md](SECURITY.md) states the threat model, and a change to any of it lands there too.**
  Every number in it — the rate-limit default, the proxy hops, the token lifetimes — is asserted
  against the code by `security.test.ts`, so a constant that moves without the file fails the suite.
  What that test cannot check is a *property* that changed: a new route, a new thing stored in the
  clear, a guarantee tightened or dropped. Those are a hand edit, in the same commit.
- Work is tracked in Linear on the
  [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team SKG).
  Reference tickets as `SKG-xxx` in commits.

## Linear MCP

The Linear MCP server is declared in [.mcp.json](.mcp.json) at the project scope. If its tools are
missing in a session, it needs to be approved and authorized (`/mcp` in an interactive session) —
it cannot be authorized from a non-interactive one.
