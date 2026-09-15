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

**It is three products sharing one core, and they differ on what the site ships** (SKG-539):
**public**, where the site embeds the widget and every visitor can leave a note; **private**, where
the site embeds nothing and the extension mounts the widget for one reviewer; **team**, where the
site embeds a dormant widget the extension wakes and relays for. [docs/modes.md](docs/modes.md) is
the page that names them for a reader, and the one thing to carry from it here: **who may read is
`read`, and the mode decides who can satisfy it.** Public mode can run `authenticated` when the host
mints its own tokens (`init({ identityToken })`, sent on reads since SKG-533); team mode is the only
one where the **reviewer** supplies the credential and the page never holds it; **private mode can
supply neither**, so it changes who is _shown_ the feedback and never who may _fetch_ it. Writing
"only team mode protects a read" is the overclaim in the other direction, and it shipped in this
file for one review round. The three-mode split is a
naming decision, not a third code path: what differs lives in the assembly layer, and
`packages/widget` does not know which one it is in.

**Status, threads, assignees and history belong to the store**, never to a second model kept in step
with it. Every store the worker speaks to is one somebody already runs: Linear is the default and
the richest of them, `FRUITBACK_STORE=sqlite` is the door for a self-hoster who wants no third
party, and `FRUITBACK_STORE=github` is for a team whose issues are already on GitHub. Fruitback does not reinvent issue tracking, and since SKG-524 it no longer requires somebody
else's account either. See [docs/architecture.md](docs/architecture.md) for the alternatives that
were dropped.

**Deployment is Docker on a VPS, driven by Dokploy from GitHub** — no Cloudflare, no serverless, no
managed platform primitives. When something needs infrastructure, reach for what a single container
behind Traefik can do.

**Deeper** — _Project_, _Layout_, and what this file said about itself before SKG-524:
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

|                         |                                     |
| ----------------------- | ----------------------------------- |
| `http://localhost:5177` | the playground page                 |
| `http://localhost:8788` | the worker, on its in-memory Linear |

`8788` and not `8080`: 8080 is the container's port, and something is usually already sitting on it
on a developer's machine. `/tf` and `/tfp` read these numbers from here rather than probing.

- **`FRUITBACK_STORE=memory` swaps the real Linear for `linear-memory.ts`**, so the whole loop runs
  with no API key and writes to nobody's workspace. It is refused under `NODE_ENV=production`, and
  `/health` answers `{ ok: true, store: 'memory', openRead: 1 }` — reads are public in the dev loop.
  It is **not** a mock: an issue is stored as the
  description `buildIssueDescription` produces and read back through production's own `toSeedIssue`,
  so a broken round trip breaks the playground too.
- The playground's toolbar and `fruitback.tsx` are **scaffolding, not the product**. Do not grow
  features there; grow them in `packages/widget`. `fruitback.tsx` only _reports_ what the widget
  decided, through `onResolve` — a client's app cannot know when to re-resolve, so the widget must.
- `apps/playground/.react-router/` is typegen, regenerated on dev and build. Ignored, not committed.

**Deeper** — _The dev loop_, and why the playground is a React app:
[docs/decisions/dev-loop.md](docs/decisions/dev-loop.md).

## The E2E suite

`pnpm e2e` (Playwright, `e2e/`) starts both servers itself and runs its specs against Chromium. It
builds `dist` first, because `package.spec.ts` loads the real file.

- It exists for the two things happy-dom cannot vouch for: a **real selector engine** and **real
  layout**. Everything else stays in `node --test`, which is where it is faster and clearer.
- Specs share one worker process, so each captures on **its own page URL** (`/?case=…`) — the seed's
  page identity is what keeps them apart. There is no reset between specs.
- **Assert on what you measured, never on a second measurement.** Poll until a value satisfies the
  check and keep _that_ value: a computed colour read mid-transition is the interpolated one (which
  Chromium serializes in another colour space), and the composer clears its confirmation 1.1s after
  showing it. Synchronise on the harness's status line rather than on a pin count — the old pins are
  still in the DOM while the new set is being fetched, so counting races.
- **A cold Vite cache is the difference between your machine and CI.** The guarantee is
  `e2e/warm-up.ts`, a `globalSetup`; `optimizeDeps.include` is not enough on its own. Reproduce the
  CI condition with `rm -rf apps/playground/node_modules/.vite`.
- **`extension.spec.ts` loads the built extension into a real Chromium** (SKG-538), and `pnpm e2e`
  builds it first. The fixture launches `channel: 'chromium'`: the headless shell Playwright uses by
  default loads no extension (measured). Automation cannot answer a host permission prompt, so it
  loads a **copy** whose manifest declares the playground and both workers. The shipped manifest still asks for
  nothing at install, and the no-rule spec runs with that grant.
- **The worker holds extension sessions during the suite** (`e2e/worker-sessions.ts`), and the team
  spec mints its code with the real `pair` command. The suite never reuses a worker already on its port: one started without
  that env holds no session store, or not that one. Stop `pnpm dev` before `pnpm e2e`. The team spec
  pairs with a **second worker on `8789`, with `FRUITBACK_READ=authenticated`**: on `public` a pin read
  back proves nothing about the relay, because the page could read it with no credential.
- **An absence needs a control.** The no-rule spec then adds the rule and sees the widget; the token
  search fails unless it finds a token in both storage areas. A spec that counts zero proves nothing alone.

**Deeper** — _The E2E suite_, the `504 (Outdated Optimize Dep)` mechanism and the four defects this
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
- **102 kB gzipped (measured on SKG-531), guarded by a test that trips at 150 kB** — a tripwire for a dependency that should
  have been bundled out, not a budget.

**Deeper** — _The published package_: [docs/decisions/packaging.md](docs/decisions/packaging.md).

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
  asserted the _build_ named one attribute and nothing had ever opened the file a reader copies from,
  so a renamed attribute left the landing page quietly wrong with a green suite. The built global is
  separately _executed_ on a real page by `e2e/package.spec.ts`.

**Deeper** — _Licences_: [docs/decisions/packaging.md](docs/decisions/packaging.md).

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
- `:host { all: initial }`, because a Shadow root blocks the page's _selectors_ but not its
  **inherited** properties. Four consequences, all of them load-bearing:
  - `style, script { display: none }` — `all: initial` undoes the browser's own rule and renders the
    stylesheet as visible text on the client's page.
  - `display` is restored at the reset in `host.ts` — every block element is otherwise inline, and
    vertical margins on it silently do nothing.
  - the reset is `*:not(svg, svg *)`. Since SVG2 a path's geometry is a CSS property, so a bare star
    computes `d: none` and every icon renders as an empty box, with nothing in the console and
    nothing a unit test can see.
  - the reset declares `color`, `font` and `letter-spacing` as `inherit`, and `:host` gives the first
    values. `all: initial` stops inheritance too: an element with no rule of its own painted black at
    16px, and the panel and the thread were 1.2:1 on the dark surface until axe measured them (SKG-544).
    `contrast.test.ts` compares tokens and cannot see it.
- **The host sits at the document origin, absolutely positioned, with no size.** The overlay places
  pins in document coordinates; move or offset the host and every pin moves with it.
- **`engine.ts` is the whole surface we take from react-grab**: hit testing across shadow roots and
  iframes, viewport bounds, source context. Three functions behind an interface, so the unit tests
  hand over a fake — happy-dom has neither `elementsFromPoint` nor layout.
- **Hit testing has to be told to ignore us.** `ignore` extends that to chrome the _page_ mounts
  around the widget.
- **Never `instanceof Element` in this package.** It reads a class off one realm, and an element from
  a same-origin iframe — which react-grab returns on purpose — belongs to another. Use `isElement`
  from `dom.ts`.

**One prefix, and it is `fruitback`**

- **`--fruitback-*` tokens, `.fruitback-*` classes, `data-fruitback-*` attributes** (SKG-580). One
  word everywhere, including on the `<script>` tag the README documents. A custom property inherits
  _into_ the Shadow root, so a name the host also uses repaints our widget silently: `--fb-` would be
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
- **`public.ts` exports the theme _types_ and not `THEME_TOKENS`.** The runtime array would widen the
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
- **The panel offers a box only for the stages the worker reports** (SKG-525). `OfferedStages` is kept
  out of `ConfigStore`, because a copy in `localStorage` would outlive a change of store. A stage the
  reporter hid stays hidden in the config. `.fruitback-config-check[hidden]` needs its own
  `display: none`: the class sets `display: flex`, which beats the browser's rule for `hidden`.
- **Do not use generic tags in the widget's chrome.** Playwright's selectors pierce open shadow
  roots, so a `<header>` in the panel made the page's own `header button` ambiguous. And inside the
  widget's region landmark a `<header>` is a banner, which axe refuses (SKG-544).
- **Two elements must not share one accessible name.** The gear says `Open Fruitback settings`
  and the dialog `Fruitback settings`. A host catalog must keep `settings.open` and `settings.dialog` apart
  too.

**The keyboard and the screen reader** (SKG-544)

- **The popover and the panel are modal dialogs, and `aria-modal` ships only with the trap.** The
  page gets no `inert`, so `holdFocus` in `focus.ts` makes the claim true: Tab stays inside, Escape
  closes and stops at the dialog, and focus goes back to what had it before the open, unless the
  reporter moved it. The thread is a dialog that is not modal: it takes focus and gives it back to
  its badge.
- **`document.activeElement` answers the host element for anything in the Shadow root.**
  `deepActiveElement` reads through it. A focus test that reads the document's answer passes for free.
- **The capture mode works without a pointer.** Down and Up walk the page in document order, Left
  goes to the parent and Right to the first child, and the two swap in a right-to-left language.
  Enter or Space selects. `CaptureEngine.grabbable` filters the walk, and `isOurs` still applies.
  **Enter is taken only while an element is highlighted**: otherwise it presses the launch button,
  which is how a keyboard stops the mode. The walk stays in the light DOM of the document; the
  pointer also reaches shadow roots and iframes.
- **A live region inside a hidden element announces nothing.** The host has its own announcer. The
  announcer for detached notes is a sibling of the list's root, which hides while empty, and `owns`
  must include it: otherwise its new text reads as a page change and schedules a resolve.
- **The host container is a landmark**, `role="region"` named by `widget.label`. A screen reader meets
  the widget in the middle of the host's content, and the landmark says what it is.
- **`contrast.test.ts` measures every pair a module paints, in both schemes, against a list of known
  failures**: the accent, the stage colours and the dark warning wait for a design decision. A pin
  sits on the host's page, so no test can promise its contrast. `e2e/a11y.spec.ts` runs axe-core in
  both schemes, scoped to `[data-fruitback-host]`, with animations off. It lets through the accent
  only, and a control fails when the accent passes. It found what the token test cannot: text that the
  reset painted black.

**The words** (SKG-530, SKG-531)

- **`messages.ts` holds every word, behind a key. English and French are bundled** and maintained
  here; English is the default. No i18n library. A host passes `init({ locale, messages })`. For
  `fr-CA` a key comes from the host's `fr-CA`, the bundled `fr-CA`, the host's `fr`, the bundled `fr`,
  then English.
- **A bundled catalog is exhaustive** (`Catalog`) and keeps English's placeholders — a test compares
  them. A host catalog is parsed field by field: a bad entry costs that entry, and a locale tag `Intl`
  refuses costs the translation, never the mount: `Intl` throws on it, and `validLocale` catches that
  and drops the catalog.
- **Plural rules and number formats follow the catalog that supplied the message.** Bylines are
  relative dates in the language of the words, with the absolute date in `title`.
- **Layout follows the reading direction; geometry never does.** `dir` and `lang` go on the host
  element, from the language of the words. The dock, the panel and the drawer sit at
  `inset-inline-end`. The pin, its badge and the document-coordinate containers stay physical, and the
  popover and the thread keep a physical `left` computed from the element's start edge.
  `direction.test.ts` reads the stylesheets and enforces the split; `e2e/direction.spec.ts` checks it
  in Arabic.
- **`languageOf(document)` reads the mounted page's navigator.** Node's global one also says `en-US`,
  so a binding that read `globalThis` passes every test that expects English.
- **A message is text.** Set it with `textContent` or an attribute, never inside an `innerHTML`
  template — the composer sets its words after the template is parsed.
- **`label` still wins over `launch.label`.** The factories take an optional `translator` and default
  to the page's language, because the playground calls them directly. `messages.test.ts` renders the
  widget in a pseudo-locale and fails on any word that did not come from the catalog.
- **The E2E suite pins `locale: 'en-US'`**, because the specs find the chrome by its English names.

**Deeper** — in [docs/decisions/widget.md](docs/decisions/widget.md):
_The widget_, _The host, and why everything lives in one Shadow root_,
_The look, and the one thing a host may change_, _One prefix, and it is `fruitback`_,
_The popover_, _Who carries the calls_, _The optional picture_, _The settings panel_, _The keyboard, the screen reader and the contrast_,
_The words, and the catalogs the bundle carries_.
And _No emoji, and what replaced them_ in [docs/decisions/icons.md](docs/decisions/icons.md).

## Re-anchoring, and why a pin says how sure it is

- `resolveAnchor` walks the anchor's claims in the order `SEED_ANCHOR_STRATEGIES` declares:
  **selector → testId → text → domPath → bounds**. That order is the contract's, and it puts `text`
  ahead of `domPath` deliberately.
- **Every match must be unique and of the captured tag**, and `domPath` must additionally still be
  roughly where the seed said it was — a structural path always resolves to _something_, and after an
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
  `resolve` keeps the pins and the open thread and only updates what was _found_, confidence marks
  included.
- **It watches the page, because nothing announces a re-render** (SKG-513). A `MutationObserver` on
  `childList`/`subtree`, debounced, plus a `ResizeObserver` per anchored element. Deliberately **not**
  `attributes`: a design system toggles classes on every hover, and what must be caught is the element
  being _replaced_.
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

Three modes: **public** (the site embeds the widget, everyone sees the pins), **private** (the site
embeds nothing and the extension injects the widget) and **team** (the site embeds a dormant widget
the extension activates and relays for). Private is SKG-534, team is SKG-596, and SKG-539 is where
they were named for a reader — [docs/modes.md](docs/modes.md) and
[docs/reviewing.md](docs/reviewing.md). Which one an origin is in is one field on its entry, and **an
entry with no `mode` reads as private** — that is every entry a reviewer's browser already holds.

- **An entry's key is a pattern, and `resolveSite` is the only lookup** (SKG-536). A key is an exact
  origin or `https://*.host`; every key written before is an exact origin, so nothing is upgraded. The
  exact origin wins, then the longest wildcard. The bridge, the relay and the popup all reach it
  through `readSite`, and `sites-storage.test.ts` proves `readSite` resolves a wildcard. A reader that
  indexed the map by origin would mount the widget and then have the relay refuse its calls.
- **A wildcard covers the default port only**, and its base host too, as a match pattern does. The
  grant and the registration (`https://*.host/*`) cover every port; the pattern carries no port because
  whether each browser accepts one was not measured, and one refused pattern stops every site. It needs
  a base of at least two labels and no IP address: every pattern is registered in one call, so a pattern
  that the browser refuses would stop the scripts on every site. If a browser registers the scripts on
  another port, the bridge unmounts there. The opposite error shows a site as on where nothing runs.
- **Only the background writes the sites map.** The popup and the options page send the change as a
  runtime message; `createSiteOwner` applies one at a time, because each change reads the whole map and
  replaces it, and the two pages share no lock. `isExtensionPage` refuses the message from a content
  script, whose URL is the page's. One key per pattern was not taken: a reader would have to list the
  whole `local` area, and the bridge, a content script, must not read the refresh token stored there.
- **A rules file holds no credential and no grant.** An imported entry runs nowhere until the options
  page's **Grant access** is pressed, and `permissions.onAdded` is what re-syncs the registration,
  because a grant writes no storage. The worker's `origins` stays an exact list, but it applies to
  private mode only: the relay calls from the extension origin, which the worker exempts. **A wildcard
  team rule lends the reviewer's session to every page it covers**, and SECURITY.md says so.
- **The rules stay in `chrome.storage.local`.** The ticket asked for `sync`; a host permission does
  not travel with a synced rule, and moving the key is a storage-shape change. That is SKG-611.

- **The private-mode widget carries no credential**, and nothing about the mode is access control.
  `page.content.ts` mounts it with no `transport`, so it calls the worker through `fetchTransport`
  from the page, exactly as a public-mode site does. Two consequences to state rather than discover:
  its reporter is self-declared like any other, and a worker on `read: 'authenticated'` answers its
  reads `401` — a reviewer then gets a page with no pins and no reason, which is SKG-605. **And that
  cannot be worked around per client**: `FRUITBACK_SESSION_PATH` alongside `FRUITBACK_CLIENTS` is
  refused at boot, so a worker holding sessions is single-tenant and its `read` is worker-wide. A
  private-mode client beside a team-mode one is two workers, or a worker left at `public`.
- **The guide's words are guarded against the popup's** (`reviewing-doc.test.ts`). `docs/reviewing.md`
  walks somebody through a screen by naming what is on it, and a renamed button leaves it describing
  a popup nobody has. The pairing failures and the mode labels are read **out of** `popup/main.ts`,
  so a fifth message is covered the day it is written; the buttons are named one by one, because a
  regex over them would guard whichever ones it happened to match.

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
  a _malformed_ message and cannot refuse a **well-formed** one the page wrote. That is inherent to
  the main world and no handoff closes it — it is stated rather than defended, because a reviewer
  grants an origin precisely because they trust that origin's code. **Nothing secret travels there,
  and an identity token is not sent at all.** `worlds.test.ts` is what keeps that true, and
  `protocol.test.ts` pins that a parsed message carries only the four fields it declares.
- **`registerContentScripts` reaches the _next_ page load, never the open one.** The popup injects
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
- **A site that embeds the widget _and_ a reviewer who has the extension get two docks.** Known,
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
- **A refresh writes nothing back once the refresh token in storage is no longer the one it spent**
  (`keepIfCurrent`), and no write means no grant either. The popup and the background are separate
  contexts sharing only storage, so a logout can land while an alarm is awaiting `/session/refresh`,
  and the answer used to put a working access token back under a screen saying signed out. The token
  is its own generation marker for that compare.
- **A logout mints a new epoch for the endpoint before it clears anything** (SKG-603), and a session
  stamped with the one before it is refused by every reader (`stillOpen`). The compare and the write
  in `keepIfCurrent` are **not** one operation and cannot be — `chrome.storage` has no transaction —
  so what covers the gap is what the write **carries**: the epoch of the very read the compare was
  made on. A logout landing anywhere around those lines leaves the endpoint logged out. Nothing
  refuses the write itself; the entry lands, unreadable, until the next pairing writes over it.
  **The stamp must come from that read and from no fresher one**, which is why `keepIfCurrent` reads
  the session itself and why the `epochs` seam has `put` and no `read` — a writer that could read the
  epoch could stamp with the logout's own.
- **A pairing mints one too, and writes it before the session it stamps.** A logout leaves an epoch
  behind on an endpoint holding nothing, so an endpoint paired again would otherwise read as signed
  out for ever. Absent on both sides compares equal, the same rule the generation follows.
- **The guard is an allowlist**: `worlds.test.ts` _discovers_ every `*.content.ts` declaring
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
- **`postJson` bounds its own request.** `refreshOnce` holds the in-flight promise so a second
  caller joins it rather than spending the token twice, so a worker that accepts a connection and
  never answers leaves that endpoint unable to refresh for the life of the service worker. Found by
  looking for the other half of a review finding about the relay's fetch. Until SKG-602 one queue
  chained every storage write, and the same hang stopped **every** worker.
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

**Deeper** — _The extension, and the two worlds_, _The session, and the token that never goes down_
and _The team mode, and the call the page cannot make_:
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
- **The rate limiter and the read cache keep their state in a `Kv`** (SKG-542), and this process
  holds one, in memory. Two replicas are therefore two ceilings — the configured limit multiplied by
  the container count — and the deployment is one container. A Redis implementation was built,
  reviewed and removed before merging: it is SKG-606, with what it learned. `kv.ts` is the seam and
  the memory store. **Values are strings**, so a value a remote store cannot hold fails here too.
- The read cache is two layers. **The in-flight promise stays in this process**, so a burst on one
  replica costs one call and N replicas cost at most N. The settled answer goes in the `Kv` for
  `CACHE_TTL_MS`. A failure is never written: an outage must not be served for the whole TTL.
- **A write invalidates by writing a new page version, never by scanning keys** — a `Kv` cannot be
  asked which keys match. The version is part of the cache key, so a read that was in flight while
  the pin was planted stores its stale answer under a version nobody will read.
- **The limiter refuses when the `Kv` does not answer** (`503 limiter-unavailable`): a limiter that
  opens during an outage is one anybody can open. `/health` never touches the `Kv`, because a
  readiness probe that depends on the `Kv` takes every replica out at once. A failed invalidation after
  a write is the opposite call — the issue exists, and a `502` would have the widget plant it twice.
- Failure codes are deliberate: `400` the caller's fault, `403` origin not allowed, `413` oversized
  body, `429` rate-limited, `500` misconfigured, `502` `store-unavailable` (the widget should keep
  the note and retry), `503` `limiter-unavailable` (the shared state is down), `401` the read needs
  an identity. `/health` answers `503` when misconfigured so a bad deploy is never routed to. **A
  code the widget reads is a promise**, so it names a role and never a vendor.

**Where a seed is stored**

- **`store.ts` is the interface.** `findForPage` states the _intention_, not the method — Linear
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
  `FRUITBACK_FAKE_LINEAR=1` is the one exception and it _degrades_ rather than refusing — a flag a
  container inherited must not stop it serving production, while a provider somebody deliberately
  named must not be silently swapped.
- **Every state the deprecated flag can be in says something at boot** (SKG-581).
  `fakeLinearIgnoredReason` answers when the flag lost — to `NODE_ENV=production`, or to an explicit
  `FRUITBACK_STORE`. `fakeLinearDeprecationNotice` answers when it selected the memory store, and
  when `FRUITBACK_STORE` took precedence over it and the flag is a stale line somebody can delete —
  **precedence, never that the store is in use**, because an explicit `memory` is still refused under
  `NODE_ENV=production` and the notice would otherwise print one line above the boot failure that
  says so. The two are mutually exclusive by construction, and a test pins that over every
  environment it enumerates. **SKG-526 shipped only the first**, which reached every operator except the ones
  still relying on the flag — the inverse of who a deprecation notice is for. `server.ts` has no test
  of its own, so the boot line is asserted on its **source**: the notice's own cases all stay green
  with the call deleted, and the warning then reaches nobody.
- **`/health` answers `store: '<provider>'`**, always, and it is compared exactly in `app.test.ts`
  because the endpoint is public.
- **A row is parsed, never trusted**, in every connector. A malformed one costs that pin; the page
  keeps its other notes. `sqlite.ts`'s `insert` and `select` are `async` so a failure to open the
  file rejects rather than throwing synchronously.
- **Every store passes `store-conformance.test.ts`** (SKG-527). The cases live in
  `store-conformance.fixture.ts`; each store gives a subject that opens it against a double that keeps
  what it receives. A step a store cannot do is a string reason, reported as skipped, never as passed.
  The outage case goes through `handleRequest`, because the promise is the `502`, not the throw. The
  store matrix in `docs/self-hosting.md` is compared with each store's `stages`, reply cap and `devOnly`.
  On a worker without `FRUITBACK_CLIENTS`, a read that names no client gets every seed on the page, on
  every store. A store that routes by client is tested with a second tenant, and a remote store with a
  rejected `fetch` and an unreadable body as well as an error status.
- **`linear-memory.ts` keeps its name and its import of `toSeedIssue` on purpose.** That coupling is
  the feature.
- **`github.ts` signs in as a GitHub App, never with a personal token** (SKG-525). An RS256 JWT from
  `node:crypto` buys an installation token narrowed to **one repository**, cached per repository until
  five minutes before it expires. Concurrent reads share one mint, a failed mint is not kept, and a
  `401` drops the token. The installation is found from the repository, so there is no variable for it.
- **GitHub's `labels=a,b` is AND** (measured on `cli/cli`: 42 for one label, 22 for the pair). It is
  what keeps one client's pins off another's site, like the `and:` clause on Linear. A count at the
  page size proves nothing: the first check compared three counts of 100. GitHub also splits the value
  on commas, caps a label at 50 characters and ignores case, so `githubLabelName` hashes any client
  label that is not plain lowercase, or that already has the shape of a hash — on the write and the read
  alike. `matchPage` rechecks every label on the row, and the client the seed names.
- **A GitHub read lists the client's issues by label and re-checks `seed.page.url`; it never
  searches.** Search is 30 requests a minute. Every page read walks the client's list, newest first,
  stopped at 1,000 issues, and the read cache is what protects the hourly budget.
- **A label that cannot be created stops a GitHub write.** A read finds a seed by its labels, so an
  issue without them is a note nobody sees again. A `502` keeps the note in the widget.
- **No parameter properties in the worker.** `constructor(readonly status: number)` is TypeScript that
  Node's type stripping refuses, and every test file that imports the module fails to load. `tsc`
  accepts it.

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
  default — that is compatibility, not security, and the exposure is made _sayable_ instead: the boot
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
- **`resolveClientIp` is security-relevant.** The client IP is the entry `TRUSTED_PROXY_HOPS` from
  the **right** of `X-Forwarded-For`. Reading the leftmost entry makes the rate limit bypassable with
  one header. **Do not write that each proxy appends**: nginx with `$proxy_add_x_forwarded_for`
  appends, while nginx with `$remote_addr`, Traefik and Caddy replace the header (measured, SKG-543).
  The self-hosting guide depends on the difference.

**The extension's session**

- **A session is credentials, and credentials are not seeds** (SKG-535). `FRUITBACK_SESSION_PATH` is
  its own SQLite file, whatever `FRUITBACK_STORE` says — a worker keeping its seeds in Linear still
  keeps its sessions on a disk it owns.
- **Do not reuse `sqlite.ts`'s `connect` for it.** That helper applies the _seeds_ migrations and
  drives `PRAGMA user_version` with them, so a session database opened through it gets `seeds` and
  `comments` tables and two schemas fighting over one counter. `session-sqlite.ts` has its own.
- **The operator names the person; the browser never does.** A pairing code is minted _for_ someone,
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
  What retires a predecessor is its **successor being used** — proof the _token holder_ received it,
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
  _last_, not _first_: the inverted version shipped into three documents and a test name. What is
  guaranteed is only that the two cannot both keep the session quietly.
  `serves whoever presents last inside the grace, until the earlier holder comes back` holds it.
- **The successor inherits the predecessor's expiry.** Thirty days from pairing stays thirty days;
  rotation shortens what a leak is worth, it does not lengthen a session.
- **The replay test is the chain, not the row**, and `revokeSession` ends the chain. A revoked
  token presented while something in its chain is still live means two parties hold one chain: that
  is the signal, and everything goes. A chain with nothing live left is an ended session and answers
  `gone`. The earlier test — revoked _and_ rotated — missed the case where a thief has the client's
  own successor revoked under it inside the grace, which left the thief refreshing for thirty days.
  The trade is that intercepting one answer in flight now ends the session at will; that capability
  already subsumes the attack. And a log out that revoked only the row it was handed left the
  successor of a lost-answer token live, held by nobody.
- **`rotated_at` marks the first rotation, never the last.** `AND rotated_at IS NULL` on that update
  is the grace being a ceiling: rewritten on every retry it slides, and whoever holds the token
  re-presents it just inside each window for ever.
- **An access token carries the generation of the session it was minted for** (`matches`). Fresh is
  not enough: the popup and the background write the same two areas from separate contexts, so a
  logout can land between a refresh writing the session and the same refresh writing its grant, and
  the orphan was then honoured for its remaining ten minutes — which revoking on the worker does not
  reach. The two writes are not one operation and cannot be, because `chrome.storage` has no
  transaction. It is an opaque id, never the refresh token: copying a credential into the session
  area would undo the split that keeps it out. Absent on both sides compares equal, so an upgrade
  keeps the session it had. Since SKG-603 that case is refused twice — the session the grant names is
  itself stamped with a run that is over — and what the generation still holds on its own is a grant
  and a session that drifted apart **inside** one run, which a partial write leaves behind.
- **One storage key per endpoint, in both areas** (SKG-602). `fruitback:session:<endpoint>` and
  `fruitback:grant:<endpoint>`, joined by `fruitback:epoch:<endpoint>` beside the session it dates
  (SKG-603), and `Area` has `put`/`drop` rather than a whole-record `write`. One
  key holding every endpoint made every write a read-modify-write, and the popup and the background
  do not share a lock: two refreshes each read the record and each replaced it, so the later write
  put the earlier one's **spent** token back — a replay, so the worker revokes the chain and the
  reviewer pairs again. A logout in the popup was written away the same way. `refreshOnce` is per
  endpoint and cannot cover this; it is what makes two workers refresh in parallel in the first
  place. A queue in `session.ts` held it inside one context only, and it is gone.
- **The key is the prefix with the endpoint appended, and the endpoint is recovered by `slice`.** An
  endpoint is a URL a reviewer typed, so `https://a.test/x:session:y` is legal and splitting on the
  separator files the entry under a worker nobody is paired with.
- **The upgrade runs once per context and everything waits on it.** `splitLegacyRecord` takes one
  `get(null)` snapshot, writes only the endpoints with no key of their own, then removes the legacy
  key — in that order, so a failure between the two leaves the credentials readable rather than gone.
  A `drop` that did not wait would remove a key not written yet and the upgrade would put the session
  back: **a logout that does not stick**, the defect the ticket is named after.
- **An upgrade that fails keeps the gate shut**, so every operation rejects. Releasing it is the
  quiet half of the same fact: a read answers that the reviewer is paired with nobody while a live
  credential sits under the legacy key. `upgradeAreas` marks its own rejection seen — an unhandled
  one stops a service worker — and still rejects for whoever waits on it.
- **`session-storage.ts` holds the keys, the `Area` factory, the upgrade and the wiring, behind a
  `StorageArea` seam**, so `node --test` reaches all of it. `session-browser.ts` is left binding
  `browser` and `fetch`. Same split as `bridge.ts`. **`createStoredSessions` is the only assembly**,
  which is what lets a test drive two `Sessions` over one storage — the popup and the background, as
  they really are — rather than over two fakes that cannot reach each other. A fake `Area` answers
  from what a test put in it, so a value the parser drops on the way out of real storage is invisible
  to it: `parseStoredSession` silently dropping the epoch is the defect that found this.
- **The epoch is read inside the sessions area, from the same snapshot as the session** — a call site
  cannot forget to ask, and no logout can land between the two halves of the comparison.
- **One refresh in flight per endpoint** (`refreshOnce` in the extension's `session.ts`). Two callers
  spending the same token is a lockout, not a wasted request: the worker treats the second as a
  retry inside the grace, revokes the first successor, and whichever answer lands last can leave the
  extension holding a revoked token. `background.ts` serialises the **alarm** only — the relay
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
  SKG-596). That list names client _sites_; an extension's origin carries an id that differs between
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
_The worker_, _The rate limit and the cache, behind a Kv_, _Who may read a pin_, _The team's replies_,
_Where a seed is stored_,
_Which store, and who validates it_, _SQLite, and what a second connector actually proved_,
_The conformance suite, and the matrix_, _The markdown codec, and the file that outlived its name_,
_The extension's session_.
And _The published image_ in [docs/decisions/image.md](docs/decisions/image.md).

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
  pushed** — and the check asserts the image _refuses_ `FRUITBACK_STORE=memory`, matching the `503`
  and the **variable name**, never the prose beside it.
- **Trivy runs with `ignore-unfixed`**, and its version carries the `v` (`# v0.36.0`). One tag out
  of seventy-five is unprefixed, so the wrong form looks valid until the next bump.
- **Every `uses:` is pinned to a 40-character commit SHA, with its version as a trailing comment**
  (SKG-608). A tag can move to other code, and the `publish` job of `release-image.yml` holds
  `packages: write`.
  `.github/dependabot.yml` moves an existing pin, SHA and comment together. It does not pin a new step:
  `workflows.test.ts` fails on any `uses:` that is not a SHA followed by its version.
- **`persist-credentials: false` on every checkout** — `actions/checkout` otherwise writes the token
  into `.git/config`, where any later step reads it.
- **Only the `publish` job holds the write permissions** (SKG-609). The workflow grants
  `contents: read`, and `packages`, `id-token` and `attestations` are declared on `publish` alone, so
  `check` builds, emulates and scans with a token that cannot publish. `ci.yml`'s `zizmor` job audits
  the workflows offline on every pull request and fails on any finding: a permission widened back or
  an unpinned action is a red check, not a review comment.
- **Attaching the package is not publishing it.** A new package inherits the repository's visibility;
  making it public is a manual, one-time change in the package settings.
- **`docker-compose.yml` pulls the image, and `compose.test.ts` holds it to the worker** (SKG-541).
  The `worker` service passes exactly `WorkerEnv` plus every store's `envNames`, except `NODE_ENV`,
  `HOST` and `FRUITBACK_FAKE_LINEAR`. Each value comes from `.env`, except `PORT`, which is the literal
  `8080`; the host side reads `FRUITBACK_PORT`. `.env.example` assigns exactly what the file
  interpolates. A new variable in the worker fails the suite until both files carry it.
- **`docs/self-hosting.md` is held to the same list** (SKG-543). Its _Every environment variable_
  section must name exactly the worker's variables and the compose file's, one table row each, with
  the code's defaults for `PORT`, `TRUSTED_PROXY_HOPS` and `RATE_LIMIT_PER_MINUTE`. What a wrong value
  breaks is written from measurements on the image; re-measure a row before changing it.
- **A documented `sqlite3 .restore` must check its file first** (SKG-543). A missing file restores as an
  empty database and exits `0`, which erased every pin in a measurement. Chain the steps with `&&`,
  put `test -s` before `.restore`, and stop the worker while it runs.
- **`/health` checks the configuration and never the store** (measured, SKG-543): a SQLite directory
  that does not exist, or a refused Linear key, answers `200` there and `502` on the first read. Do
  not describe `/health` as proof the worker can serve.
- **The compose file sets `TRUSTED_PROXY_HOPS` to 0; the code defaults to 1.** The file publishes the
  port directly, and 1 there lets a forged `X-Forwarded-For` escape the rate limit (measured). Keep
  the two defaults apart in prose: `security.test.ts` pins the code's.
- **CI's `image` job plants a pin through the compose file from an empty directory**, with the fresh
  build tagged under the name the file pulls. A variable exported in the shell wins over `.env`, so
  run the same check locally under `env -i`.

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
- **A store can report only some stages, and says which** (SKG-525). `SeedStore.stages` travels as
  `stages` on every `GET /feedback`, with or without pins — derived from the pins on screen, an empty
  page would offer the wrong boxes. `offeredStages` reads it tolerantly and answers every stage when
  the field is absent. GitHub reports `seeded`, `ripe` and `composted`. A read-envelope field, so
  `SEED_VERSION` does not move.
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
  - **The root is an Nx project too, named `workspace`, with `format` and `format:fix` only**
    (SKG-584). It formats what no package owns: `e2e/`, `docs/`, the root Markdown and JSON.
    `.oxfmtignore` gives `apps/` and `packages/` back to their own targets, and only this target
    reads it. Do not move that list to `ignorePatterns` in `.oxfmtrc.json`: every package reads that
    file, and its `oxfmt --check .` then finds no file at all.
  - **`"nx": { "includedScripts": [] }` in the root `package.json` is load-bearing.** Without it,
    Nx makes every root script a target of `workspace`. A root `test` script is `nx run-many -t test`,
    so that target would start `nx run-many -t test` again.
  - **`format:fix` is never cached** (`nx.json`). It writes files and declares no outputs, so a cache
    hit on the same unformatted input replayed the log and rewrote nothing (measured).
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
  What that test cannot check is a _property_ that changed: a new route, a new thing stored in the
  clear, a guarantee tightened or dropped. Those are a hand edit, in the same commit.
- **`CONTRIBUTING.md` carries the rules a person trips over on a first pull request** (SKG-520). It
  points at this file and does not repeat all of it. `contributing.test.ts` holds its `pnpm` scripts,
  ports, Node and pnpm versions, CI checks and commit types to their sources. A new convention that an
  outside contributor cannot guess belongs there too, in one sentence.
- Work is tracked in Linear on the
  [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team SKG).
  Reference tickets as `SKG-xxx` in commits.

## Linear MCP

The Linear MCP server is declared in [.mcp.json](.mcp.json) at the project scope. If its tools are
missing in a session, it needs to be approved and authorized (`/mcp` in an interactive session) —
it cannot be authorized from a non-interactive one.
