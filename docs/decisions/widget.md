# The widget

The browser half: how a seed is captured, why everything lives in one Shadow root, what a host may
restyle, how a pin says how sure it is, and who carries the calls to the worker.

## The widget

### The rules, in short

- **`env` is off unless the integrator asks** (FRU-84): `includeEnv` defaults to `false`, and on the
  `<script>` tag only `data-fruitback-include-env="true"` turns it on. A reporter who does nothing is
  anonymous, and a user agent with a language narrows down who they are. `docs/privacy.md` and its
  notice template say what is sent, so a change to this default changes them too.
- **A component name a bundler minted is worse than none.** `isMangledComponentName` drops them and
  the walk continues to the first name a human wrote. It deliberately does **not** climb to the app's
  own component. **`bound qi` is `qi`**: a bound function carries a `bound ` prefix, and a production
  build reported that name because two words did not look minified (FRU-113). The prefix is taken off
  before the name is judged, and off a name that is kept.
- **A file a bundler wrote is no source either** (FRU-113). On a production build the engine names
  the chunk (`/assets/site-state-Bgn4uEnK.js`) with a line and a column of one minified line.
  `isBundleChunk` knows it by the content hash before the extension, and `sourceFromContext` sends
  no file, line or column for it. A line and a column go with their file.
- **The place of a note is read at the click, not at the send** (FRU-152). The page stays live while
  the popover is open, and a link of a single-page app or the back button changes its address. So
  `embed.ts` reads the page, the viewport, the anchor and the source with `capturePlace` when the
  reporter chooses the element, and `captureSeed` takes them as `place`. The note goes to the page
  where it was written. The picture is still taken at the send, so it is left out when the address
  changed or the element left the page. `e2e/navigation.spec.ts` sends a note after a navigation of
  the client.

### The reasons, and the history

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

### The rules, in short

- `:host { all: initial }`, because a Shadow root blocks the page's _selectors_ but not its
  **inherited** properties. Four consequences, all of them load-bearing:
  - `style, script { display: none }` — `all: initial` undoes the browser's own rule and renders the
    stylesheet as visible text on the client's page.
  - `display` is restored at the reset in `host.ts` — every block element is otherwise inline, and
    vertical margins on it silently do nothing. **A new block element goes into that rule.** `ul` and
    `ol` were missing until FRU-154: the replies of a thread were inline, so their `max-height`, their
    scroll and their indent did nothing. `e2e/thread.spec.ts` reads the computed `display`.
  - **A list that scrolls takes focus and has a name** (FRU-154): the replies have `tabindex="0"` and
    `thread.replies`, or axe reports `scrollable-region-focusable` and a keyboard cannot read the end.
    The note and each reply have `overflow-wrap: anywhere`, because an address has no space.
  - the reset is `*:not(svg, svg *)`. Since SVG2 a path's geometry is a CSS property, so a bare star
    computes `d: none` and every icon renders as an empty box, with nothing in the console and
    nothing a unit test can see.
  - the reset declares `color`, `font` and `letter-spacing` as `inherit`, and `:host` gives the first
    values. `all: initial` stops inheritance too: an element with no rule of its own painted black at
    16px, and the panel and the thread were 1.2:1 on the dark surface until axe measured them (FRU-51).
    `contrast.test.ts` compares tokens and cannot see it.
  - **The text has one rule, in the reset** (FRU-350): the reset declares `overflow-wrap` and
    `white-space` as `inherit`, `:host` gives `overflow-wrap: anywhere`, and `button`, `[role=switch]`,
    `[role=tab]` and `kbd` take `white-space: nowrap`. Content wraps anywhere, so an address, a file
    path or a long word stays in its box; a label never breaks inside its words. A button that holds a
    note (a row of the list, a detached note) says `white-space: normal` in its own module. An
    identifier is a label too. The extension (`popup/style.css`) and the console (`app.css`) write the
    same rule on `body`. `e2e/wrap-widget.spec.ts`, `wrap-extension.spec.ts` and `wrap-console.spec.ts`
    measure each surface at 320, 390 and 1280 px, in English and in French, with long data, through
    `e2e/overflow.ts`; `overflow.spec.ts` plants each fault it must find.

### The reasons, and the history

- `createCaptureHost` owns the widget's DOM: the floating button, the hover highlight, and — through
  `host.root` — the overlay's pins and whatever the note UI turns out to be.
- **A Shadow root is the only version of "no style conflicts" that survives a real client site.** It
  stops their `button { width: 100% !important }` from reshaping our toolbar _and_ our rules from
  reaching their page. Neither direction is achievable with prefixed class names.
- `:host { all: initial }` on top, because a Shadow root blocks the page's _selectors_ but not its
  **inherited** properties — `body { font-family: Papyrus }` reaches in otherwise. The catch: `all:
initial` also undoes the browser's `display: none` on `<style>`, which then renders the stylesheet
  as visible text in the corner of the client's page. Hence `style, script { display: none }`. Both
  are covered by E2E tests, because neither is visible to a DOM emulator. The reset on every element
  inside stops inheritance too, so it declares `color` and `font` as `inherit` (FRU-51, in _The
  keyboard, the screen reader and the contrast_).
- **The host sits at the document origin, absolutely positioned, with no size.** The overlay places
  pins in document coordinates, and absolute positions resolve against the nearest positioned
  ancestor — move or offset the host and every pin moves with it.
- **`engine.ts` is the whole surface we take from react-grab**: hit testing that crosses shadow roots
  and iframes, viewport bounds, and the source context. Three functions behind an interface, so the
  unit tests hand over a fake — happy-dom has neither `elementsFromPoint` nor layout — and a library
  change lands in one file.
- **Hit testing has to be told to ignore us**, since react-grab traverses open shadow roots and would
  otherwise return our own highlight box. `ignore` extends that to chrome the _page_ mounts around
  the widget (the dev toolbar today, FRU-14's config panel next). Note what it does not do:
  react-grab walks _past_ a rejected candidate, so hovering our own chrome highlights whatever is
  behind it. Harmless; capturing it would not be.
- **Never `instanceof Element` in this package.** It reads a class off one realm, and an element from
  a same-origin iframe — which react-grab returns on purpose — belongs to another. Use `isElement`
  from `dom.ts`.

## The look, and the one thing a host may change

- **`theme.ts` owns every colour, shadow, radius, font family and duration** (FRU-35, FRU-36). They were
  hexadecimals spread across five `STYLES` literals — `host.ts`, `overlay.ts`, `composer.ts`,
  `panel.ts`, `orphans.ts` — plus the stage colours, which travelled in the _published contract_.
- **Custom properties, because inheritance is what crosses the modules.** Each module injects its own
  `<style>` into the one Shadow root, so a token on `:host` reaches all of them with nobody importing
  anything. `THEME_STYLES` is concatenated ahead of `host.ts`'s reset for that reason.
- **The prefix is `--fruitback-`, and it is the whole defence.** A custom property inherits _into_ the
  Shadow root from the client's page — the root blocks their selectors, never their inherited
  properties — so a name the host also uses repaints our widget silently. `--color-text` would be
  reckless, and `--fb-` no better: it is what a Facebook SDK or somebody's flexbox utilities would
  plausibly pick.

## One prefix, and it is `fruitback`

### The rules, in short

- **`theme.ts` owns every colour, shadow, radius, font family and duration.** Each module injects its
  own `<style>` into the one Shadow root, so a token on `:host` reaches all of them. **The base
  `:host` block must declare every settable token** — a token declared only under
  `prefers-color-scheme: dark` is undefined in light mode, and the test that checks this is scoped to
  that block for exactly that reason.
- The pin's silhouette is **not** in the radius scale: `border-radius: 50% 50% 50% 0` is a shape, not
  a corner size. Spacing is still literal on purpose.

### The reasons, and the history

- **`--fruitback-*` tokens, `.fruitback-*` classes, `data-fruitback-*` attributes.** One word
  everywhere (FRU-53), including the names on the `<script>` tag the README documents.
- **It took three goes, and the reason it landed here is worth keeping.** `--fb-` was reckless for a
  property that inherits into a Shadow root. `--fruit-` fixed that and introduced a subtler problem:
  the repo then had `--fruit-`, `.fruit-`, _and_ `data-fruitback-` on the script tag, and an
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
  explains the current name; the first pass of FRU-53 spared them mechanically and left a paragraph
  describing a distinction the code had stopped making, which is the worse failure — a comment that
  outlives what it described.
- **`init({ theme })` takes tokens, never CSS.** A host that could write a stylesheet into the Shadow
  root would turn our class names into a contract by accident, which is what the Shadow root exists
  to prevent. `applyTheme` writes only names `THEME_TOKENS` declares and silently drops the rest, so
  a token renamed in a later version costs that override and never the mount.
- **`public.ts` exports the theme _types_ and not `THEME_TOKENS`.** The runtime array would widen the
  published surface; `package.test.ts`'s test:``promises only what `public.ts` declares`` caught that on the
  first attempt, which is what it is for.
- **The base `:host` block must declare every settable token**, and the test that checks it is scoped
  to that block. Searching the whole stylesheet passed a mutation that deleted a declaration, because
  the dark block redeclares it — a token declared only under `prefers-color-scheme: dark` is undefined
  in light mode.
- **Radii are tokenised now, and the order of the two moves is the point** (FRU-36). FRU-35 refused
  to name eight distinct values, because eight tokens each used once is indirection wearing the
  costume of a scale. FRU-36 shortened the scale first — 4, 6 and 8 became `sm`; 10 and 12 became
  `md`; 14 and 18 became `lg`; 999px is `pill` — and named the four that were left. Naming them before
  reducing them would have frozen the accident.
- The pin's silhouette is **not** in that scale: `border-radius: 50% 50% 50% 0` is a shape, not a
  corner size, and it is the product's identity rather than a preference a host may set.
- Spacing is still literal — nobody overrides it, and substituting sixty numbers is where a silent
  visual regression hides.
- FRU-35 changed **no colour**: every token holds the hexadecimal that was already there, and
  `e2e/overlay.spec.ts`'s computed-colour read is the proof. One shadow moved 4px, because the thread
  and the panel spelled the same intention two ways.
- **FRU-233 changes most of them, on purpose.** FRU-35 moved the colours into tokens and changed
  none. The mock-up of 2026-10-13 (« simpler flow », FRU-230) changes the palette: the warm stone
  greys become a neutral zinc scale, and the five « fruit » colours of the stages become five plain
  status colours. A site that already has the widget sees it at its next load: **every pin changes
  colour**, and the greys of the popover, the thread, the list and the settings turn neutral. The
  names of the stages (`new`, `todo`, `progress`, `done`, `closed`) are the contract and do
  not change. The values are read in the CSS of the mock-up, never by eye:

  | Token                         | Before              | After                     |
  | ----------------------------- | ------------------- | ------------------------- |
  | `color-text`                  | `#1c1917`           | `#18181b`                 |
  | `color-text-muted`            | `#78716c`           | `#6b6b74`                 |
  | `color-text-subtle`           | `#7a736e`           | `#52525b`                 |
  | `color-surface-raised`        | `#fffdf9`           | `#fafafa`                 |
  | `color-border`                | `#e7e5e4`           | `#e4e4e7`                 |
  | `color-border-strong`         | `#8f8883`           | `#8a8a93`                 |
  | `color-chip`                  | `#44403c`           | `#3f3f46`                 |
  | `color-success`               | `#4e7d2a`           | `#15803d`                 |
  | `color-warning`               | `#8d6e63`           | `#b45309` (not drawn)     |
  | `stage-seeded`, new           | `#6a7950`           | `#dd2c27`                 |
  | `stage-green`, to do          | `#56802e`           | `#2563eb`                 |
  | `stage-ripening`, in progress | `#ac5f00`           | `#f59e0b`, written in ink |
  | `stage-ripe`, done            | `#8c1d40`           | `#15803d`                 |
  | `stage-composted`, closed     | `#8d6e63`           | `#64748b`                 |
  | `shadow-sm`, `shadow-xl`      | tinted `28, 25, 23` | tinted `24, 24, 27`       |

  Token names of before FRU-355 (`seeded`, `green`, `ripening`, `ripe`, `composted`): they are
  `new`, `todo`, `progress`, `done` and `closed` since, see [stage-names.md](stage-names.md).

  New tokens, each a value of the mock-up that a screen of FRU-252 to FRU-259 paints:
  `color-accent-strong` (`#b91c1c`), `color-surface-sunken` (`#f4f4f5`), `color-on-stage-progress`
  (`#18181b`), `color-ink`, `color-on-ink`, `color-on-ink-muted` (the banner of a capture),
  `color-unplaced` (`#d97706`), `shadow-xs`, `radius-field` (8 px), `font-mono` and `ease-out`
  (`cubic-bezier(0.16, 1, 0.3, 1)`). The popover arrives on that curve in 420 ms, where it had an
  overshoot in 220 ms. A screen takes a value from a token, and no token is defined outside
  `theme.ts`.
  - **« In progress » is written dark.** White on the amber is 2.15:1, the ink is 8.25:1.
    `onStageToken` gives a stage its foreground, and `color-on-stage` stays the white of the four
    others, so a host that set that one token keeps it. FRU-292 replaced the test that held it,
    gone-test:`writes « in progress » dark on its amber, where white cannot be read (FRU-233)`, by
    gone-test:`writes « in progress » white on its amber, like the four others (FRU-292)`, which
    FRU-334 replaced in turn.
  - **The amber is 2.15:1 on white, under the 3:1 of a drawing, and it stays**: it is the colour
    the mock-up gives that status. A status is never said by its colour alone: the list names it,
    a thread names it, a pin carries a number. `contrast.test.ts` names that one pair, and fails
    when it passes or when another one fails.
  - **The mock-up draws no dark scheme. It is kept, and derived**: the same zinc scale from its
    other end (`#18181b` surface, `#27272a` raised, `#f4f4f5` text, `#a1a1aa` muted), every pair
    measured. The five stages keep their values there: each is 3.43:1 or more on the dark surface.
    The red of the dark accent stays `#ec6a65`: the `#ec5b57` of the mock-up's dark rail is 4.40:1
    on the raised surface, under what text needs. `prefers-contrast: more` is unchanged.
  - **`color-warning` is not in the mock-up.** Its brown belonged to the stone palette. It is the
    amber of the mock-up darkened until it holds as text, 5.02:1.
  - `e2e/overlay.spec.ts` reads the five colours on five real pins, and the ink on the amber one.

- **FRU-292 changes them again: the mock-up of 2026-10-20.** It brings the warm stone greys back,
  gives the five stages new colours, and gives **each surface its own accent**: the widget keeps the
  red `#dd2c27` on the page of a host, the extension paints its own pages in `#c2410c`. The greys,
  the statuses, the shadows and the radii are shared, and `apps/extension/src/design-tokens.test.ts`
  compares them; the accent is checked against its own value on each side. Going back to one accent
  is a change of one line, and of that test. **FRU-372 went back to one accent** (Mathieu,
  2026-10-21): the extension paints the red of the widget and of the console, the dark accent
  `#ec6a65` in the dark scheme, and the test compares the accent like the greys. The values of
  FRU-292 are read in the CSS of the mock-up:

  | Token                         | 2026-10-13 (FRU-233)      | 2026-10-20 (FRU-292)    |
  | ----------------------------- | ------------------------- | ----------------------- |
  | `color-text`                  | `#18181b`                 | `#1c1917`               |
  | `color-text-muted`            | `#6b6b74`                 | `#756e69`               |
  | `color-text-subtle`           | `#52525b`                 | `#57534e`               |
  | `color-surface-raised`        | `#fafafa`                 | `#fafaf9`               |
  | `color-surface-sunken`        | `#f4f4f5`                 | `#f5f5f4`               |
  | `color-surface-warm` (new)    | —                         | `#fffdf9`               |
  | `color-border`                | `#e4e4e7`                 | `#e7e5e4`               |
  | `color-border-strong`         | `#8a8a93`                 | `#8f8883`               |
  | `color-chip`                  | `#3f3f46`                 | `#44403c`               |
  | `color-ink`                   | `#18181b`                 | `#1c1917`               |
  | `color-on-ink-muted`          | `#a1a1aa`                 | `#d6d3d1`               |
  | `color-success`               | `#15803d`                 | `#3f6421`               |
  | `color-unplaced`              | `#d97706`                 | `#8d6e63`               |
  | `stage-seeded`, new           | `#dd2c27`                 | `#6a7950`               |
  | `stage-green`, to do          | `#2563eb`                 | `#56802e`               |
  | `stage-ripening`, in progress | `#f59e0b`, written in ink | `#ac5f00`, in white     |
  | `stage-ripe`, done            | `#15803d`                 | `#dd2c27`               |
  | `stage-composted`, closed     | `#64748b`                 | `#8d6e63`               |
  | `shadow-xs`                   | `rgba(24, 24, 27, .12)`   | `rgba(28, 25, 23, .15)` |
  | `shadow-sm`, `shadow-xl`      | tinted `24, 24, 27`       | tinted `28, 25, 23`     |

  Token names of before FRU-355 (`seeded`, `green`, `ripening`, `ripe`, `composted`): they are
  `new`, `todo`, `progress`, `done` and `closed` since, see [stage-names.md](stage-names.md).

  - **The muted text is one step darker than the mock-up.** Its `#78716c` is 4.40:1 on the sunken
    surface, where the open note of the list writes its byline. `#756e69` is 4.59:1 there and
    4.98:1 on the surface: the smallest step that holds 4.5:1 everywhere it is painted.
  - **Every stage holds white**, from 4.62:1 (closed) to 4.78:1 (in progress), and is 4.62:1 or
    more on the surface. `contrast.test.ts` has no known failure any more. `color-on-stage-progress`
    stays, because a host may have set it, and holds white.
  - **The dark scheme is derived, and Mathieu validates it on the captures of the PR**: stone 900,
    800 and 700 (`#1c1917` surface, `#292524` raised, `#312c29` sunken, `#44403c` border), `#f5f5f4`
    text, `#a8a29e` muted, `#8f8883` for the edge of a field (5.01:1 on the surface, 3.95:1 on the
    sunken one). The red of the accent stays `#ec6a65` under dark text (5.68:1 on the surface,
    4.92:1 on the raised one). The five stages keep their values: 3.66:1 or more on the dark surface.
  - `color-warning` keeps its amber: the mock-up draws none. The dock of FRU-303 paints the detached
    notes in the brown of « closed ».

- **FRU-334 changes them a third time: less brown, closer to the console of the Cloud.** Mathieu
  asked on 2026-10-21 for « une palette moins marron », closer to what the console draws, and chose
  the five statuses himself. The greys go back to the zinc of `apps/console/app/app.css` (the values
  of FRU-233), the creams and the browns of detail go with them, and **`theme.ts` is the one source
  of the statuses**: the extension and the console copy them, and
  `apps/extension/src/design-tokens.test.ts` and `apps/console/app/tokens.test.ts` fail when a copy
  differs.

  | Token                         | 2026-10-20 (FRU-292) | 2026-10-21 (FRU-334)               |
  | ----------------------------- | -------------------- | ---------------------------------- |
  | `stage-seeded`, new           | `#6a7950`, white     | `#bec2c8`, black (9.90:1)          |
  | `stage-green`, to do          | `#56802e`, white     | `#d9dbdf`, black (12.78:1)         |
  | `stage-ripening`, in progress | `#ac5f00`, white     | `#f3bb3d` (mango), black (10.11:1) |
  | `stage-ripe`, done            | `#dd2c27`, white     | `#5560c4` (blueberry), white 5.45  |
  | `stage-composted`, closed     | `#8d6e63`, white     | `#a52a3a` (cherry), white 7.02     |
  | `color-stage-edge` (new)      | —                    | `#8a8a93`                          |
  | `color-unplaced`              | `#8d6e63`            | `#71717a`                          |
  | `color-text`, `color-ink`     | `#1c1917`            | `#18181b`                          |
  | `color-text-muted`            | `#756e69`            | `#6b6b74`                          |
  | `color-text-subtle`           | `#57534e`            | `#52525b`                          |
  | `color-surface-raised`        | `#fafaf9`            | `#fafafa`                          |
  | `color-surface-sunken`        | `#f5f5f4`            | `#f4f4f5`                          |
  | `color-surface-warm`          | `#fffdf9`            | `#fafafa`                          |
  | `color-border`                | `#e7e5e4`            | `#e4e4e7`                          |
  | `color-border-strong`         | `#8f8883`            | `#8a8a93`                          |
  | `color-chip`                  | `#44403c`            | `#3f3f46`                          |
  | `color-on-ink-muted`          | `#d6d3d1`            | `#d4d4d8`                          |
  | `color-success`               | `#3f6421`            | `#15803d`                          |
  | `shadow-xs`, `-sm`, `-xl`     | tinted `28, 25, 23`  | tinted `24, 24, 27`                |

  Token names of before FRU-355 (`seeded`, `green`, `ripening`, `ripe`, `composted`): they are
  `new`, `todo`, `progress`, `done` and `closed` since, see [stage-names.md](stage-names.md).

  - **Black on new, to do and in progress, white on done and closed**, as Mathieu's table says.
    `color-on-stage-new` and `color-on-stage-todo` are new, beside `color-on-stage-progress`;
    `onStageToken` reads them, and `color-on-stage` stays the white of the two others and of the
    ring, so a host that set it keeps it. test:`writes new, to do and in progress black, and done and
closed white (FRU-334)`.
  - **Every drop has an edge, measured.** New is 1.79:1 on white, to do 1.39:1, the mango 1.75:1:
    a light pin on a white page stood out by its soft shadow only, and 1.4.11 asks 3:1 of a drawing.
    One pixel of `color-stage-edge` (`#8a8a93`, the field border of the console) outside the white
    ring of every pin: 3.42:1 on white, while the white ring carries the pin on a dark page. A
    shadow alone was rejected: a blur has no edge to measure, and it fades on a grey page. A dark
    ring instead of the white one was rejected too: it is lost on a dark page. The edge has one
    value in both schemes, because a pin lies on the page of the host. The marks of the list, the
    chips, the drop of a thread and the frame of a pointed note take the same edge; on the dark
    surface it is 5.18:1, where blueberry (3.25:1) and cherry (2.52:1) need it. `contrast.test.ts`
    measures the edge where it measured the fill. test:`draws the edge of a drop in one grey in both
schemes, outside the ring of the pin (FRU-334)`.
  - **A note with no place is grey, not the colour of « closed ».** It was the brown of closed; a
    detached note is not closed, and closed is a cherry now. `#71717a`: 4.83:1 on the surface, and
    white on its chip 4.83:1.
  - **The dark scheme is derived again**, from the zinc of the console: `#18181b` surface, `#27272a`
    raised, `#2e2e33` sunken, `#1f1f23` for the quoted block, `#3f3f46` border, `#f4f4f5` text,
    `#a1a1aa` muted, `#4ade80` success. The red of the dark accent stays `#ec6a65`: 5.75:1 on the
    surface, 4.83:1 on the raised one. Mathieu validates it on the captures of the PR.
  - The accent stays the red `#dd2c27`, which is the console's too.

- **The pins, their frame and the dock have the measures of the mock-up** (FRU-252, screens 14 to
  16). Read in its CSS, held by `e2e/overlay.spec.ts` and `e2e/host.spec.ts` on computed styles.
  - **A pin carries the number of its note**: its place among the notes of the page, counted before
    a stage is hidden, so hiding one gives no other note its number. `overlay.resolutions()` gives
    the number, for the list. A note kept for later has none.
  - **The number took the place of the `≈`** of a pin placed by position. One drop holds one mark,
    and the number is what ties a pin to its line of the list. The dashed frame, the name of the pin
    and the thread still say that the place is approximate.
  - **The name of a pin is « Note 2, in progress: » and then the note.** The mock-up names it
    « Note 2, in progress ». The note stays in the name: it is how a screen reader tells two pins
    of one status apart, and how every spec finds a pin. The mock-up also writes « , open » in the
    name of the open pin, beside `aria-expanded="true"`: the attribute alone is kept, or a screen
    reader says it twice.
  - **The drop of the mock-up of 2026-10-20** (FRU-304): 28 px, a ring of 2 px of the foreground of
    the stages (white), turned by 45 degrees so that its sharp corner points down, the number in
    12 px 700, turned back upright. **Its point is on the element**: on its top edge, 16 px in from
    its start corner, or in its middle when it is narrower than 32 px. At the top of the document,
    with less than 34 px above the element, the point goes down into it by what is missing. Open,
    the drop grows to 115 %, above the others. Held by `e2e/overlay.spec.ts` (± 1 px).
  - **The frame shows only while its note is pointed at, focused or open**: a line of 2 px, 3 px
    off the element (`FRAME_OUTSET` is 5), in the colour of the status, as an outline would draw
    it, and with no fill. At rest it is transparent: the mock-up draws the drop alone.
  - **Found by position, not by identity**: the same drop, its ring dashed, and the frame dashed when
    it shows. The number stays: the list needs it. The legend of the mock-up writes « ≈ » in the drop;
    the name of the pin and the thread say it in words.
  - **Detached: listed in the dock, not on the page.** A note whose element is gone draws no pin
    (`display: none`); the chip of the capsule counts it and its list opens its thread. A note kept
    for later keeps its pin where it was planted.
  - **The title of a drop is « In progress · the note »**, as the mock-up writes it. Its name keeps
    « Note 2, in progress: the note », with the number.
  - **The dock is one capsule** (FRU-303, mock-up of 2026-10-20), 24 px from the corner, on the
    surface, with the border, the round ends and the shadow of the mock-up. In it, in this order:
    the chip of the detached notes (« 1 detached », in the brown of « closed »), the list, the gear,
    and the launch button. Held by `e2e/dock.spec.ts` on computed styles, with the animations off.
    - **Every control in it is 44 px**, and draws the shape of the mock-up inside a transparent
      border: 36 px for the list, the gear, the chip and the way out of a capture, 40 px for the
      launch button. The capsule is then the 52 px of the mock-up, and no target is under 44 px.
      The cost: two controls stand 8 px apart where the mock-up has 4.
    - **The overlay puts the chip at the start of the capsule**: `createOverlay({ dock: host.dock })`.
      Without `dock` the chip floats alone above the corner, as before. The detached chip floated at
      `bottom: 60px` and covered the dock; `e2e/dock.spec.ts` plants that rule back as its control
      and sees the overlap. Its list opens above the capsule.
    - **The list and the gear are drawings on the capsule**, in the subtle text (`#57534e`, not the
      `#44403c` of the mock-up: that one is the chip, which the dark scheme cannot hold on its
      surface), with a sunken fill under the pointer. The list is a panel beside the page, drawn
      in `icons.ts`. It opens the list in the page. The side panel of the extension (FRU-296) is not
      on `main`: when it is, the button will ask the extension first.
    - **No landmark of its own.** The host element is already the region « Fruitback feedback »:
      a second region with that name is two landmarks a screen reader cannot tell apart.
    - **The launch button's drop is the mark**, 11 by 14 px (`mark` in `icons.ts`), not the pin.
      Its name in French is « Laisser une note »; the `label` of the host wins.
    - **In a forced palette** every border is painted, the transparent ones too, and fills are
      dropped: the borders take `Canvas`, and the launch button and the way out draw their shape
      with an outline of `ButtonText`.
  - **Kept, though the mock-up does not draw it**: the gear of Phosphor, whose own gear is another
    drawing; and the name of the gear, « Open Fruitback settings »: the mock-up names it
    « Fruitback settings », which is the name of the dialog it opens, and two controls with one
    name cannot be told apart (`docs/translating.md`).

- **The bubble of a note has the measures of the mock-up** (FRU-256, screen 14). Read in its CSS,
  held by `e2e/thread.spec.ts` on computed styles.
  - **Three parts, each behind a rule**: a head (the drop and the word of the status, its age, the
    way out to the store, the cross), the note (its text, who and when, the block of mono), the
    replies. 344 px wide (FRU-304), a border of 1 px, 14 px of corner and the shadow of the thread.
    The colour of the status is the drop beside its word.
  - **It opens beside the drop** (FRU-304): 26 px past its point on the end side of the reading
    direction, or on the other side when the window has no room there; 8 px above the top of the
    drop, and never nearer than 24 px to the top or the bottom of the window. When neither side has
    the room, it opens under the pin as before, or above it. That is every phone.
  - **The age of the status**, « yesterday », « 2 days ago », in 12 px, from the last change the
    store reports (`updatedAt`), with the day in its title. The mock-up words it per status
    (« since yesterday », « for 1 day »): one relative date says it in every language the widget has.
  - **The block of mono** (FRU-304): the selector the note carries, in 12 px, then
    « <HeroBanner> · src/components/Hero.tsx:42 » in 11 px, from its `source`. A note with no source
    has the selector alone. On the warm surface, with a border and 6 px of corner.
  - **The dialog is named « Note 2 »**, the number of its drop, and the cross « Close the note »:
    the mock-up names it « Close », and two crosses of the widget can be on screen. The cross is
    28 px drawn and 44 px to press.
  - **The link is the identifier and an arrow, « ACM-142 → »**, in a chip of the sunken surface, 44 px
    to press. The widget does not know which store is behind the worker (FRU-31), so it does not
    write « in Linear ». A store with no address of an issue has no chip.
  - **« Replies »**, in 11 px capitals, above the replies or above « No reply yet. ». Each reply has
    the initial of who wrote it in a round of 24 px, then « **Léa** · 1 day ago » in 11 px, then its
    text in 13 px.
  - **« Camille Durand · 2 days ago », not « · guest »**, and « Léa · yesterday », not
    « · Sakuga »: a read gives the name of who wrote, not the role nor the workspace. Same reason.
  - **Nothing to answer with.** The field « Reply to Camille » of the mock-up waits for a
    decision (who may answer from a page, and as whom).
  - **Kept, though the mock-up does not draw it**: « No reply yet. », which is not the same as
    saying nothing; the two sentences about an approximate place, under the byline; the replies
    capped at 180 px with a scroll a keyboard can reach (FRU-154), 10 px apart; a note kept for
    later, whose head says « Not sent yet » behind a grey drop, with no link; the dark scheme; and
    an outline in forced colours, where a shadow is not drawn.

## The popover

### The rules, in short

- **The capture and the composer have the measures of the mock-up** (FRU-258, screen 15). Read in
  its CSS, held by `e2e/capture.spec.ts` and `e2e/composer.spec.ts` on computed styles.
  - **A capture turns the capsule of the dock dark** (FRU-303): the ink of the mock-up, in both
    schemes, 46 px tall, in its corner. It holds the banner: « Point at an element, or use the
    arrow keys » in 12 px, then the way out, the key « Esc » drawn as a key and « Cancel ». The
    launch button, the list, the gear and the chip stand aside. The banner of FRU-258 sat at the
    top of the window; the way out is now where the way in was. The banner is the one
    `role="status"` that speaks at a start, always in the tree and empty at rest. How a keyboard
    moves is in it, read and not drawn. The key is `aria-hidden`: the button is named « Cancel ».
    On a touch screen it says « Tap… » and draws no key.
  - **The launch button keeps its name and says `aria-pressed`.** Hidden while a capture runs, it
    gives its focus to the way out, where Enter still stops the capture, or chooses the element the
    keyboard reached. « Cancel », Escape and a choice give focus back to the launch button, so a
    dialog opened by the choice returns there. A start from elsewhere (the shortcut of the
    extension) leaves focus where it is.
  - **The frame of a capture is a line of 2 px, 3 px off the element**, as an outline would draw it,
    with nothing over the element: a tint hid the colour the note is about. Its corners are those of
    the element grown by 5 px, so a round button gets a round frame.
    **What the note points at is written above it, centred**: « button.add · <Button> » in the mono
    of a selector, the short selector alone when the engine knows no component. The short selector
    is the tag and the stable id, or the stable class the fewest elements share (the last on a tie,
    never a modifier): a design system writes « button button--md add », and « button.button »
    says nothing. The engine is asked once for each element of a capture. The label is
    `aria-hidden` and takes no click: the note carries the name, and a screen reader hears the
    element.
  - **The frame stays on the chosen element while the composer is open**: `init` calls
    `host.hold(element)` at the choice and `host.release()` at the close. A host that assembles the
    parts itself and calls neither keeps what it had, a frame that goes at the choice. **The banner does not stay, and one click is still one note.** The mock-up draws
    the banner, the pressed button and the composer in one picture; a still does not say whether a
    capture goes on after a note, and a banner that says « click the page » over a modal dialog
    would not be true. Asked in FRU-258.
  - **A second capture over an open composer loses nothing.** A pointer reaches the launch button
    under the composer, whose focus trap holds the keyboard only. Stopped, the capture gives the
    frame back to the element the composer is about. With another element chosen, the composer
    keeps everything the reporter set (the note, a name typed over the one remembered, a place, the
    sentence of a failed send), its head names the new element, and it moves to it; the frame of
    the first does not come back. While a note is sending, a choice is let go: the note in flight
    is about the element before, and a failure must still find its text.
  - **The composer of the mock-up of 2026-10-20** (FRU-305): 360 px with a border of 1 px. It
    opens **above** its element, 40 px over its top, on the edge of the frame (5 px off the
    element); below when there is no room above. It rises from the corner nearest to its element,
    with no fade. Held by `e2e/composer.spec.ts` on computed styles.
    - **The head**, on the warm surface: the drop of « new », what the note points at in mono
      (« button.add · <AddToCart> », as the frame writes it: `aboutTarget` in `host.ts`), with what
      the element says as its title, and « Pick again ». « Pick again » is the seam `onPickAgain`:
      `init` starts a capture over the open composer, which keeps the text and moves to the element
      chosen. The cross is gone: « Cancel » and Escape close it. The dialog keeps the name
      « New note », where the ticket writes « Leave a note »: every spec and every screen reader
      knew it by that name, and it does not repeat the launch button.
    - **The body**: « Your comment » above the field of 96 px (its label, which names it; the
      placeholder « What should change? » stays), « Name (optional) » above a field of 36 px in
      sight (the link « Add my name (optional) » is gone; a signed reader still sees no field),
      « Remember me on this site », and the box of the picture, in the accent. The e-mail of the
      mock-up is not there: a new personal datum (FRU-58, open question 2).
    - **The foot**: « Lands in {place} as a new issue » when a member sees one place, « Sent to the
      team » otherwise; with several places, the line of the body that lets a member choose stays,
      and the foot says nothing. « Cancel » and « Send », 34 px drawn and 44 px to press, « Send »
      with the drop of the mark.
    - **Sent**: a card takes the place of the composer for 4 s, or until a click anywhere else: the
      drop of « new » with the number of its pin, « Sent as DEV-3 », « The pin stays here and
      follows the issue's status. » in green, and « Open → » when the reader may open the issue.
      `init` finds them in the read that follows the send, by the id of the seed (`onSeed` of
      `plant`). It said « Sent » for 1.1 s before. A note kept for later still says so in the foot.
    - **Failed**: a card above the foot, `role="alert"`: « Did not go through », then the sentence of
      its cause (FRU-156). The text stays in the field.
  - **« Attach a picture of the element » is the preference of the settings panel**, shown beside
    the note (`PictureChoice`, a seam like `NameMemory`). It is there only when the host gave
    `captureScreenshot`, **the composer never ticks it**, and a tick is kept at once. The mock-up
    shows it ticked because its person chose it. Nothing new is read, sent or kept: the same
    setting, the same picture, the same storage. `e2e/screenshot.spec.ts` sends a note with the
    box never ticked and reads no picture, then ticks it and reads one.
  - **No « As Mathieu, Sakuga ».** A read says that the worker would sign the note (`identified`),
    not the name nor the workspace. Saying them is a new field of a public response of the worker.
    A signed reader sees no line; a visitor keeps the field « Name (optional) ».
  - **Kept, though the mock-up does not draw it**: « Keep for later », a ghost like « Cancel »; the
    line of the destination, under the note; the sentences of a failed send, « Sending… » and
    « Sent », where the identity line would be; the sheet at the bottom of a phone, with the fields
    at 16 px; the dark scheme.
- **One field, the name, and no e-mail** (FRU-91). It is optional, behind a disclosure, and never
  `verified` — that flag is the worker's to set. `reporter.email` stays in the seed contract, because
  an identity token can carry one.
- **The widget remembers a name only for a reporter who ticked the box.** `NameMemory` is a seam like
  `onSubmit`: the composer does not know where the name is kept, and `embed.ts` gives it the config
  store. The name is written before the send, so a failed send costs neither the name nor the
  choice. Unticking the box erases at once. With `identityToken`, the composer asks for no name: the
  worker would replace a typed one. In team mode the worker says so on a read (`identified`, FRU-112).
- **A line says where the note goes, only to a reader the worker offers two places or more**
  (FRU-123). The worker names the places in `destinations` on a read, to a member of the workspace
  and to nobody else, so every other composer is the one of FRU-89. `offeredDestinations` reads the
  field like `offeredStages`, with one difference: **one bad entry costs the whole list**, because
  the first place is the default by its position. The list lives in `OfferedDestinations` and never
  in `ConfigStore`; the id chosen last does (`destination`), and it is followed only while the worker
  offers it. `DestinationChoice` is a seam like `NameMemory`.
- **The choice travels as `POST /feedback?destination=<id>`, and only when it is not the first
  place** (`destinationToSend`). The body stays the seed. `apps/extension/src/relay.test.ts` reads
  the paths of `embed.ts` up to the `?`: write the two addresses as two whole templates. A refusal
  with a choice reads again, so the composer shows the list of now and says which place is gone.
- **A failed send says what to do next, by its cause** (FRU-156). `plant` answers `true` or a
  `SendFailure` (`failureOf`): `retry` for no answer and a `5xx`, `wait` for a `429`, `refused` for a
  `403`, `signed-out` for a `401` (FRU-193), `too-large` for a `413`. A `403` that names a place gone
  (`destination-not-allowed`) is a `retry`: the read after it makes the list right. The text is kept
  in every case, and the sentence takes its own line above the buttons, in the live region.
- **A `401` has its own sentence** (FRU-193): « Your session has ended. Your text is kept: sign in
  again, then send it. » It shared the sentence of the `403`, which sends the reporter to the team of
  the site, and that team can do nothing about a session of the extension that ended or a token of the
  host out of date. It does not say « try again » alone: the token is asked for again at each send,
  and a host that mints a bad one mints it again. The widget does not know which of the two it is, so
  the sentence names no extension and no button.

### The reasons, and the history

- **`createComposer` owns the states, not the transport.** `onSubmit` is awaited, so an embedder
  posts through whatever it set up while the widget stays ignorant of the worker's URL and of auth.
- The states are the point, and they are unit-tested because none of them can be seen by looking:
  the send button is disabled in flight (**a second click would plant the same note twice**, and the
  worker cannot tell the difference), a failure keeps the popover open **with the text intact**, and
  a refusal (`onSubmit` resolving `false`) is treated as a failure rather than a success.
- **Name and e-mail are optional, behind a disclosure, and never `verified`** (FRU-9). Anonymous
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
- The pin is a drop: three round corners and one sharp, rotated to point at the corner of its element, with a
  squash-and-stretch entrance. The note moved to the badge's `aria-label` — that is what keeps it
  reachable by a screen reader, and by a test looking for it by role.
- **One field to say who you are, and a box to be remembered (FRU-91).** The disclosure opened two
  fields, a name and an e-mail, on every note, and kept neither.
  - **The e-mail field is gone.** An address is not needed to read a note, and it is the piece of
    personal data a reporter leaves without thinking. The cost is stated in
    [privacy.md](../privacy.md): the team cannot answer an anonymous reporter outside the page, and
    `forget --email` finds no note that carries a name only.
  - **Nothing is kept by default.** A box, « Remember me on this site », keeps the name under the
    config key, in the `localStorage` of the page. The page can read that key, which is why the box
    is the reporter's to tick and not a default.
  - **The name is written before the send, and erased when the box is unticked.** A write after a
    successful send loses the choice on a failed one, which is when a reporter retries. A box that
    forgets only at the next send keeps a name its owner asked to drop.
  - **A stored name is read like the rest of the config**: a string, trimmed, at most 120
    characters, or nothing. The key stays absent rather than empty.
  - **With `identityToken`, the composer asks for no name.** The worker replaces a typed name by the
    identity of the token, so the field would promise a signature that is not used.
  - **In team mode the worker tells the widget, on a read (FRU-112).** There the session names the
    reviewer, and the widget is given a transport and nothing about who is behind it: the field
    stayed, and what was typed in it was dropped with no word. `GET /feedback` now answers
    `identified: true` to a reader whose token it verified, and `embed.ts` keeps the word of the last
    read that answered, like the places of FRU-123: an answer without the field takes it back, a
    failed read changes nothing. Of the three ways the ticket listed, this is the one with no new
    option of `init` and no new field on the API the extension announces.
    - **One bit, and not « Signing as Alex ».** The page reads that answer. A name there would give
      the page the name of a reviewer who has written nothing yet, and the notes do not show that.
      Showing who signs is an open question in the ticket.
    - **`ComposerOptions.identified` takes a function, asked at each open and by
      `identityChanged()`.** A closed composer takes the new answer at once. An open one keeps the
      answer it opened with: a field must not leave under somebody who types in it. A name typed
      before is kept, hidden, and not sent.
    - **Before the first read answers, the composer asks.** A reviewer who opens it in that moment,
      or whose first read failed, can still type a name that the worker replaces. The field hidden
      by default would take it from every anonymous reporter for the time of a read.
    - **The page is not told of a pairing**, so a reviewer who pairs and writes at once, on a page
      that was open before, is still asked for the first note: the send makes a read, and the field
      is gone for the next one. A reload, or a return to the tab after 15 seconds, makes that read
      too. Measured in `e2e/extension.spec.ts`, where the first version of the assertion failed for
      this reason. Telling the page is a change of the extension, and a question in the ticket.
    - `e2e/extension.spec.ts` holds it in a browser: the field is there before the pairing, which is
      the control, and gone after.
- **A member chooses where a note goes, on a line at the foot of the composer (FRU-123).** The
  worker half is `apps/worker` (`Site.destinations`, `seesTracker`); this is what the widget does
  with its answer.
  - **The line is there from two places, and for nobody the worker did not name them to.** The
    worker puts `destinations` (`[{ id, label? }]`) in the answer of a read for a session whose role
    has `see-tracker`. A visitor, a guest, a client and an older worker send no such field, and the
    composer is then the one of FRU-89: the two elements are hidden, and the place of the notice is
    empty and takes no height. `e2e/destination.spec.ts` measures that.
  - **Folded, on one line: « Send to: Linear · Web ».** Most notes go where the one before went, so
    the line says where and asks nothing. It unfolds to radios, one for each place, in the order of
    the worker. No board of `design/` draws it: it is the disclosure of the name and the row of the
    box that remembers the name, on the same tokens.
  - **The list is read like `stages`, except that one bad entry costs all of it.** A stage is a
    name, and a list of stages with one removed is still right. A place is the default by its
    position: with the first entry removed, the line would show the second as the default while the
    worker sends a note that names no place to its own first. A bad label costs the label, and the
    place is then called by its rank (`composer.destinationUnnamed`): the worker has no label for a
    place set before it wrote them.
  - **The list is not stored, and the choice is.** `OfferedDestinations` is in memory for the reason
    `OfferedStages` is, and for one more: these are the names of a tracker, for this reader, now.
    `ConfigStore` keeps the id chosen last. That store refuses `endpoint` and `clientId` because a
    page can write its key (FRU-89). The id is not such a route: it is followed only while the worker
    offers it to this reader, the line shows it, and the worker checks it again on the write. A page
    that writes the key chooses first among the places its reviewer may use, and no more. The id of
    another site is offered by no read here, so one key for an origin is one choice for a site.
  - **Only a choice travels, in the query.** `POST /feedback?destination=<id>` when the place is not
    the first, and the request of everybody else when it is. The body is the seed and nothing more:
    the relay of the extension compares no query and carries no header but two. An older worker gets
    no parameter, because it sent no list.
  - **A refusal with a choice reads again.** The worker answers `403` for a place the site no longer
    has and for a reader who may no longer choose. The note is kept like on any refusal. But the list
    on screen is then old, and a second try would be refused like the first, with nothing to say why.
    The read brings the list of now. The composer goes back to the first place and says so in words
    (`composer.destinationGone`), because the next send goes there.
  - **The notice is said only for a popover that is open.** A list that changed between two notes
    promised nothing to anybody. And when the list keeps only the place the line showed, nothing is
    said: one place is the default.
  - **Not here**: the screen of the console where an admin sets and orders the list.

## Who carries the calls

- **`transport` is a seam, and it is the same one twice** (FRU-56). The widget stays dormant when a
  host has nothing to reach the worker with, and the extension relays the calls when it does. Those
  looked like two features; they are one question — _who carries this_ — asked once.
- **Plain objects, not `Request` and `Response`.** Neither survives `postMessage`, and the
  implementation this exists for lives on the other side of one. `TransportRequest` is a URL, a
  method, headers and an optional body; `TransportResponse` is `ok`, `status` and a text body.
- **Dormancy is not an option on `init`, it is not calling `init`.** A promise on `init` was the
  first design and it was wrong: `init` is synchronous and hands back a `ConfigPanel`, so deferring
  the mount would have made that panel a promise or a proxy. A site that wants the widget only for a
  reviewer waits for its transport and calls `init` then. A widget that was never built shows
  nothing and asks for nothing, which is a stronger promise than one that hides itself — and the
  waiting has to live somewhere either way, so the promise only moved it.
- **`transportFor` is one line and one place**, because a call site added later would otherwise take
  the default and leave a host's relay out of the loop with nothing to see. `embed.test.ts` reads the
  source and asserts two things: no bare `fetch(` survives, and the default is named exactly twice —
  the import and that one line. The second check is what catches a bypass the first cannot, since
  calling the default directly is not calling `fetch`.
- **That count includes comments**, which the first version learned by failing: a sentence naming the
  default sat in `transportFor`'s own docstring and made three.
- **The lookbehind excludes a word character and not a dot**, and the first version excluded both.
  `globalThis.fetch(` and `view.fetch(` went straight through a check written to stop exactly them.
  Raised in review, and the mutation now measured red.
- **`plant` is exported for its tests and never from `public.ts`.** The composer sits behind a hit
  test happy-dom cannot do, so the write path had no unit cover and a regression in its method,
  headers or body would have passed — the source guard rules out a bypass, not a malformed request.
  What `plant` actually needs is a target, and a target is an element, which happy-dom does have.
  Raised in review. What stays `e2e`'s is the composer calling it at all.
- **`fetchTransport` does not catch.** A worker nobody can reach rejects, `embed.ts` treats that and a
  failed status identically, and swallowing it here would only hide an outage from an implementer who
  wanted to log it. Mutation-tested.
- **One existing assertion changed, and it was asserting the mechanism.** test:`sends no Authorization
header when the host mints no token` compared `fetch`'s second argument to `undefined` — true only
  because the old code passed nothing there. Every call carries a method now, so it asserts the
  absence of the header, which is what its own comment always said it meant.
- **`identityToken` and `transport` overlap and are left overlapping.** In the extension's mode the
  relay holds the session, so the token seam is dead there; with no extension the transport is the
  default, so the relay is dead. Unifying them belongs with the extension side, not here, where there
  is nothing yet to unify against.

## The optional picture

- **The widget does not bundle a rasteriser** (FRU-6). `captureScreenshot` is a seam the embedder
  fills, for two reasons that each stand alone: the seed contract stores a **URL**, so the image has
  to live in someone's storage, and html2canvas weighs more than this entire widget — bundling it
  would break `package.test.ts`'s 150 kB tripwire and the promise that tripwire guards.
- **Off by default, and the toggle is absent unless `captureScreenshot` was given.** A switch that
  controls nothing is what kept this setting out of FRU-14. The composer shows the same preference
  beside the note since FRU-258, under the same two conditions.
- **A capture that throws costs the picture and never the note.** A canvas tainted by a cross-origin
  image is the ordinary outcome, not the exotic one; the E2E test for this fails by losing the note
  entirely when the guard is removed.
- The flow past the setting is **E2E-only**: `init` resolves what was clicked through react-grab's
  hit testing, which happy-dom has no `elementsFromPoint` for. The unit tests stop at the toggle and
  say so rather than asserting negatives that would hold even if nothing ran.

## The files of a note (FRU-332)

### The rules, in short

- **One text button, « Attach », opens a menu of the ways to join a file** (FRU-351, decision of
  Mathieu): « Add an attachment » (the file picker, any type), « Capture an area », « Capture the
  whole page » (both only with a `captureVisible` of the host) and « Drag and drop », a zone where a
  dropped file joins the note, with « Choose a file » for whoever cannot drag. The menu is a
  `role="menu"` under a button `aria-haspopup="menu"`: the arrows open it and go round, Home and End
  go to the ends, Enter takes a way, Esc closes it and gives the focus back to « Attach », Tab and a
  click out close it. A capture and a file picked give the focus back to « Attach »; Esc of the drop
  zone hides it. While the note is sent, and after, no file joins it: the drop zone hides, and a file
  dropped, picked or captured then is not taken, since no note would name it (FRU-373). The worker says on each read whether files go: `canAttach: true` offers the
  menu, `false` shows the sentence that the note has no tracker and no way, absent shows nothing. A
  place of a member says it for itself (`destinations[].canAttach`).
- **No pin, no tooltip, no open thread and no frame of the element on a capture** (FRU-351): from
  the start of a capture, the area being chosen included, the host carries `data-fruitback-shooting`,
  which hides the overlay and the highlight; they come back in a `finally`, after the capture, a
  cancel, or a capture that fails (`e2e/attachments.spec.ts` reads the pin during each one).
- **A file goes on its way when it is joined**, through the transport (`POST /attachments`, its bytes
  in base64 for any transport). A refusal is said under its name at once, and a file over its limit
  (`MAX_ATTACHMENT_BYTES`, the same constants as the worker) or a sixth file is refused before it is
  sent. The note names the files the worker took, in `?attachments=`, never in the seed; it waits for
  a file still on its way.
- **Each file shows its name, its size and a button to remove it**, named by the file. Nothing is
  lost on a failure: a refused file, a `410 attachment-gone` or a `409 attachments-not-taken` of the
  send keep the text and say what to do.
- **A note with files is sent, never kept for later**: « Keep for later » goes while a file is joined.
  A draft waits in the tab, and a batch cannot say which note a file is of.
- **The widget shows no file that Fruitback serves.** A sent note says « 1 attachment » in its
  thread, with the link of its ticket; a guest reads the count alone.
- **The area of a capture works with the keyboard** (`area.ts`): an area is drawn at once in the
  middle, the arrows move it, Shift and the arrows size it, Enter takes it, Esc cancels. A drag draws
  a new one. The widget is hidden for the two frames before the capture. Esc and Enter give the focus
  back to « Capture an area »: the area reads the active element through the Shadow root of the
  widget (`deepActiveElement`), where `document.activeElement` is only its host (FRU-353,
  test:`gives the focus back to « Capture an area » in the Shadow root of the widget, after Esc and after Enter`).

## The settings panel

### The rules, in short

- **What is not configurable is the design** (FRU-14). The Linear team, project and labels are
  absent, and since FRU-89 the worker and the client id are too. The panel holds no field to type in:
  it is seen by a client on their own site, and where the notes go is not for a reporter to say.
- **`endpoint` and `clientId` are not in the config store** (FRU-89). They are the word of the
  caller of `init`. The store restores its key from the page's own `localStorage`, so a stored copy
  let a page that wrote the key first choose where the notes go, and beat a new default for ever. A
  `pinned` option covered that for a mount with its own key only; an ordinary embed stayed exposed.
- **Do not use generic tags in the widget's chrome.** Playwright's selectors pierce open shadow
  roots, so a `<header>` in the panel made the page's own `header button` ambiguous. And inside the
  widget's region landmark a `<header>` is a banner, which axe refuses (FRU-51).
- **Two elements must not share one accessible name.** The gear says `Open Fruitback settings`
  and the dialog `Fruitback settings`. A host catalog must keep `settings.open` and `settings.dialog` apart
  too.
- **The panel of the mock-up of 2026-10-20** (FRU-305): a head with the drop of the mark in the
  accent, « Settings » and a cross of 28 px drawn in 44 px. **« Pins shown » is a chip for each
  status**: 30 px drawn in a target of 44 px, the drop of its colour and its name; shown, the sunken
  fill and the strong edge. The box stays, over the whole chip and out of sight, so the keyboard,
  a click and a screen reader find a box. **The two settings are switches** (36 × 20, `role="switch"`),
  on in the ink of the text, off in the edge of a field (the #d6d3d1 of the mock-up is 1.4:1 on
  the surface and would not show where it is), at the end of a row of 44 px that toggles them.
  « Open notes in a sidebar » and « Connection » (worker, client) are not drawn: the first waits for
  the preference of FRU-302, and the widget keeps neither `endpoint` nor `clientId` (FRU-89).
- **The panel offers a box only for the stages the worker reports** (FRU-32). `OfferedStages` is kept
  out of `ConfigStore`, because a copy in `localStorage` would outlive a change of store. A stage the
  reporter hid stays hidden in the config. `.fruitback-config-chip[hidden]` needs its own
  `display: none`: the class sets `display: flex`, which beats the browser's rule for `hidden`.

### The reasons, and the history

- **What is not configurable is the design** (FRU-14). The ticket asked for the Linear team, project
  and labels; they are absent. Since FRU-15 the worker resolves those from the client id and refuses
  an id it does not know, so a browser naming its own team would either be ignored — a setting that
  does nothing is worse than none — or obeyed, which lets any page write into any workspace. The
  client id is what the reporter can say; what it routes to stays server-side.
- `config.ts` is the store, `panel.ts` the UI. It writes on every change rather than behind a Save
  button, and **reading `localStorage` can throw** rather than return `null` — Safari in private
  browsing raises on the property itself, so the widget must still start with storage refused.
- **The stored config is parsed like a seed**: tolerant, field by field. It is a string a human can
  edit in devtools, and a malformed one costs the reporter their preferences, never the widget.
- **Filtering lives in the overlay, not in the embedder.** `shouldShow` plus `refilter` redraw from
  the issues already held, so hiding a stage costs no request — and, as with FRU-21, a client's app
  is not going to re-fetch on the widget's behalf.
- **The panel offers a box only for the stages the worker reports** (FRU-32). The list arrives with
  each read and lives in `OfferedStages`, not in `ConfigStore`: the config store persists to
  `localStorage`, and a stored copy of what one worker reports would outlive a change of store. A
  stage the reporter hid stays in `hiddenStages` while no box shows it, so a worker that reports it
  again shows the reporter's choice. The "hide resolved" shortcut disappears when no resolved stage is
  offered, because it would control nothing.
- **A hidden box needs its own `display: none`.** `.fruitback-config-check` sets `display: flex`, and a
  class rule beats the browser's rule for the `hidden` attribute, so the box would stay on screen with
  `hidden` set. happy-dom does no layout, so `panel.test.ts` reads the rule from the stylesheet.
- **Do not use generic tags in the widget's chrome.** Playwright's selectors pierce open shadow
  roots, so a `<header>` in the panel made the page's own `header button` ambiguous for anything
  reading the composed tree. The panel uses a `div`, and the E2E specs scope to `main header button`.
- **Two elements must not share one accessible name.** The gear says `Open Fruitback settings`
  and the dialog `Fruitback settings`, and a host catalog must keep them apart too; giving both the same name is ambiguous to a screen reader and
  to any test that finds elements by name.
- **The worker and the client id left the panel, and the store with it (FRU-89).** The panel showed
  two text fields, « Worker » and « Client », above the stage filters. A client who reviews their own
  staging site saw them, could not know what they were, and a change there sent the notes somewhere
  else with nothing on screen to say so. They are the caller's word: `init`, the script tag, or the
  extension's rule.
  - **Removing the fields was not enough.** The store still read `endpoint` and `clientId` back from
    `localStorage`, and the page can write that key. `pinned` closed it for a mount that named its
    own key, which is the extension only. Every ordinary embed followed a stored endpoint: the test
    that said so was named « still remembers under the default key », and it now asserts the
    opposite. `WidgetConfig` holds `hiddenStages` and `screenshot`, and `pinned` is gone.
  - **A config stored before is read field by field, so the two old fields cost nothing.** The next
    change writes the config without them.
  - **The panel opens on its first stage box.** It opened on the endpoint field. The close button is
    the fallback, for a worker that reports no stage.
  - **The read no longer debounces.** The debounce existed because a keystroke in the endpoint field
    was a new query. A preference change now only redraws from the issues already held.
  - **The dev loop changes worker with `VITE_FRUITBACK_WORKER`**, which is where the playground
    always took its default from.

## The feedback as text (FRU-109)

### The rules, in short

- **`export.ts` is one pure function, and `feedbackAsText()` on what `init` returns is the same
  text the panel's button copies.** It reads `overlay.resolutions()`, so it costs no request and
  leaves out a stage the reporter hid. It is an addition to the contract in `public.ts`.
- **The text holds no instruction and no introduction.** It is what the reviewers wrote and where.
  A sentence that tells a reader what to do with it belongs to whoever pastes it.
- **Every line a reviewer wrote is quoted, and every value of ours is one line.** A note is text
  from anybody who can reach the page. Unquoted, a line of it can pass for a heading of this
  format, or for the note after it. A selector goes in a code span one backtick longer than its
  longest run. The quote stops a forged structure. It does not make the text safe to obey.
- **The words are catalog keys, the dates are not.** `2026-10-06` reads the same in every language.
  `messages.test.ts` holds a key that never rendered as a failure, so the copied text is pushed
  into that check by hand: it is in no DOM node.
- **A clipboard can refuse.** The panel then shows the text in a field, selected. The field is made
  on demand: at rest the panel holds no field to type in (FRU-89).

### The reasons, and the history

Asked for as a « basic » text mode: the comments of a page in a form somebody can paste to an agent,
with no context and no instruction added.

- **Markdown, because the two readers both take it.** A person pastes it in a ticket; a model reads
  headings and lists without being told the format. JSON was not taken: the seed is already JSON,
  and the request was for text.
- **One block per note**: a heading with the identifier and the status, a list of facts, the note
  quoted, then each reply quoted under one line that names its author. A fact with nothing to say
  is left out. The ticket's first sketch put the note in the heading; a note has line breaks and
  its own markdown, so the heading holds only values of ours.
- **The quote is the format's one defence, and it is a defence of structure.** `quote` prefixes
  each line, so a note that writes `## 2. FB-99 — Done` or a code fence stays a quoted line.
  `export.test.ts` holds a detector for it: the same check finds the forged lines once the quote
  marks are removed. An identifier, a status, a name and a component come from a store or a
  reporter too, and each is folded onto one line.
- **It does not make a note safe to obey.** A note written by a visitor in public mode can say
  anything, and an agent with rights on a repository reads it. That is the subject of FRU-110, and
  the reason this function adds no instruction of its own: an instruction of ours next to a hostile
  note gives the note a voice to imitate.
- **The status is the store's word**, like the thread, with the stage as the fallback. **The
  position is said only when it is not sure**: approximate, or not found. The words are the
  thread's.
- **`resolutions()` answers `confident` now.** The text needs « found by position » apart from
  « found », and the strategy alone made the caller know which strategies identify.
- **The button is in the settings panel**, which is where the stage filters are: the text is what
  the filters leave. It is absent when the panel was given nothing to copy.
- **The clipboard fails often enough to plan for it**: no permission, a page that is not a secure
  context, an old browser. The fallback is a read-only field with the text selected, made when the
  copy fails and removed when one works.
- **Not in this ticket**: sending the notes anywhere. `feedbackAsText()` is on what `init` returns
  so a host can do that itself.

## The words, and the catalogs the bundle carries (FRU-37, FRU-38)

### The rules, in short

- **`messages.ts` holds every word, behind a key. English and French are bundled** and maintained
  here; English is the default. No i18n library. A host passes `init({ locale, messages })`. For
  `fr-CA` a key comes from the host's `fr-CA`, the bundled `fr-CA`, the host's `fr`, the bundled `fr`,
  then English.
- **A bundled catalog is exhaustive** (`Catalog`) and keeps English's placeholders — a test compares
  them. A host catalog is parsed field by field: a bad entry costs that entry, and a locale tag `Intl`
  refuses costs the translation, never the mount: `Intl` throws on it, and `validLocale` catches that
  and drops the catalog.
- **French says « note », never « feedback »**, as the console and the list do (FRU-287). A status of
  a send (« Sent », « Envoyée ») stands alone, so it starts with a capital. `messages.test.ts` holds
  both.
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
- **The E2E suite pins `locale: 'en-US'`**, because the specs find the chrome by its English names.

### The reasons, and the history

- **`messages.ts` holds every word the widget shows, behind a key.** No i18n library ships: a record
  of strings and `Intl.PluralRules` cost a few hundred bytes, under a size guard that trips at 150 kB.
- **English is the default, and French is bundled beside it** (FRU-38). The project is open source,
  so its default is the language most readers share. FRU-37 shipped English alone, and for that
  release a French site showed English until it passed `messages`. A French browser now gets French
  with nothing passed.
- **`ENGLISH` is exhaustive, and so is every bundled catalog.** `Catalog` requires every key, so a
  key added to English does not compile until French has it too. `messages.test.ts` also compares
  each French message's `{placeholders}` with the English one's, which the type cannot see.
- **A host catalog is parsed like the stored config**: field by field. An unknown key, a string where
  a plural belongs, a plural with no `other` — each costs that entry, and the next catalog in the chain takes its place. A
  locale tag that `Intl` refuses is ignored: `new Intl.PluralRules('not a tag')` throws, and a typo
  must cost the translation, never the mount.
- **Catalogs are keyed by locale tag, and a key walks a chain.** For `fr-CA`: the host's `fr-CA`, the
  bundled `fr-CA`, the host's `fr`, the bundled `fr`, then English. Each key takes the first catalog
  that has it in the right shape, so a host overriding one French word keeps the bundled French for
  the rest. `locale` wins over `navigator.language`.
- **The plural rules and the number format follow the catalog that supplied the message.** Portuguese
  puts 0 in `one`, so an English fallback read with Portuguese rules would say "0 detached note"; a
  German count reads `1.234` and its English fallback `1,234`.
- **A byline says when relative to now, in the language of the words** (`Intl.RelativeTimeFormat`,
  FRU-38), and carries the absolute date in its `title`. The absolute date follows the locale the
  reader asked for, not the catalog. The label is computed when the thread is drawn. No timer
  refreshes it, but a re-resolve redraws an open thread, so "3 hours ago" can move forward then. A date the store wrote in a shape `Date` cannot read is shown as it
  came.
- **The language comes off the mounted document's own window**, never off `globalThis` — the realm
  rule `isElement` exists for, and `languageOf` is the one place. Node's global navigator also says
  `en-US`, so a binding that read it would pass every test expecting English. The tests set the
  page's navigator to French and assert the global one disagrees.
- **A message is text.** The composer's template is parsed with `innerHTML`, so its words are set as
  properties afterwards and never interpolated into it. A test hands it markup and checks that nothing
  was parsed.
- **`label` still wins over `launch.label`.** A host's label is the host's word, in any language.
- **The factories take an optional `translator` and default to the page's language**
  (`languageOf(document)`), because the playground
  calls them directly. What stops a word escaping the catalog is `messages.test.ts`: it renders the
  widget in a pseudo-locale whose messages are their own keys, through the states it drives, and fails
  on any letter that is neither a key nor fixture data. It first asserts that the keys it expects did
  render, or it would check nothing.
- **The E2E suite runs with `locale: 'en-US'`.** The specs find the chrome by its English names, and
  a runner with another default language would change every name with nothing in the report to say
  why.
- **The script tag gets detection only.** A catalog cannot travel in a `data-` attribute. Detection
  reaches the bundled catalogs, so a French browser gets French from a bare tag; any other language
  needs `Fruitback.init`.
- **The extension mounts with no catalog**, so a reviewer's widget follows their browser into the
  bundled catalogs — French for a French browser — while the popup stays English.
- **The direction comes from the language of the words**, not from the language the reader asked for.
  An Arabic reader with no Arabic catalog reads English, left to right. `directionOf` reads the likely
  script through `Intl.Locale.maximize`, because Firefox does not implement `getTextInfo`.
- **Layout follows the direction; geometry never does.** `dir` and `lang` go on the host element and
  the Shadow root inherits them. The dock, the settings panel and the detached-notes drawer sit at
  `inset-inline-end`. The pin, its badge and every container that holds document coordinates stay
  physical: a pin placed against an element of the page must not move when the words flip.
- **The popover and the thread are the middle case.** Their position is computed against an element,
  so it stays a physical `left`; the computation aligns them on the element's start edge, which is
  its right in a right-to-left language.
- **`direction.test.ts` reads the stylesheets**, because happy-dom resolves no logical property. A rule
  that names a physical side must be declared geometry, geometry must name no logical property, and
  the dock, the panel and the drawer must be at the inline end. `e2e/direction.spec.ts` mounts the
  built widget in Arabic and checks in a browser that the dock and the popover move and the pin stays
  on its element.
- **The link of a thread is a message** (`thread.link`), though it is the identifier alone since
  FRU-256: a language may need a word around it. It held an arrow before, which a right-to-left
  catalog pointed the other way.
- **Each bundled catalog weighs on the size guard.** If the list grows, catalogs load on demand; the
  guard is not widened.

## The keyboard, the screen reader and the contrast (FRU-51)

### The rules, in short

- **The popover and the panel are modal dialogs, and `aria-modal` ships only with the trap.** The
  page gets no `inert`, so `holdFocus` in `focus.ts` makes the claim true: Tab stays inside, Escape
  closes and stops at the dialog, and focus goes back to what had it before the open, unless the
  reporter moved it. A capture-phase listener on the document brings a Tab from the page back in,
  because the page is not inert. **Only the dialog opened last keeps Tab**: the gear opens the panel
  over an open popover. The thread is a dialog that is not modal: it takes focus and gives it back to
  what opened it, its badge or a detached-note entry, and a render moves focus to the rebuilt badge.
- **The reset removes the focus ring too**, and `host.ts` restores one on `:focus-visible`. **The gear
  stops the capture mode**, and the capture mode leaves the keys to a dialog of the widget that has
  focus: both take the arrows and Enter from the document. While no widget dialog has focus, the
  capture mode consumes the arrow keys, and it consumes Escape only when Escape cancels the capture.
  Enter on a widget control other than the launch button presses that control.
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
- **`contrast.test.ts` measures every pair a module paints, in both schemes, and no pair fails**
  (FRU-93). A pin sits on the host's page, so no test can promise its contrast. `e2e/a11y.spec.ts`
  runs axe-core in both schemes, scoped to `[data-fruitback-host]`, with animations off, and finds
  nothing. Its control repaints a label grey and expects a finding: an empty list proves nothing
  alone. Axe finds what the token test cannot, because that test compares the tokens a pair names and
  not the rule that paints them: text that the reset painted black, and a label that kept the
  foreground of the accent on the chip.
- **On a touch screen, no control is under 24 × 24 px** (WCAG 2.5.8), and the close buttons and the
  controls of the dock are 44 px (FRU-157, FRU-303). The rule is `@media (pointer: coarse)` in each
  module, and the glyph keeps its size: the button grows around it. A box or a radio is measured by
  its label, which a tap toggles. The fields are at 16 px there, because iOS Safari zooms the page
  into a smaller field and stays zoomed. The banner of a capture says `capture.bannerTouch` and
  names no key, because a phone has no Escape key (the launch button said it until FRU-258). `e2e/touch.spec.ts` measures every visible control
  at 390 px, and its control plants a 10 px button.
- **In the dark scheme the accent and the warning are light fills with dark text on them.** Each one
  is a fill under text and also text on the surface, and no single red does both with white text.
  A style that changes a background must change the foreground with it.

### The reasons, and the history

The widget lays itself over somebody else's page, which may have been audited. An accessibility
defect of ours is a defect of theirs.

**The dialogs.**

- The popover and the settings panel are `role="dialog"` with `aria-modal="true"`. `aria-modal` tells
  a screen reader that the rest of the page is out of reach, and the widget makes nothing `inert`, so
  the attribute ships with the trap and never alone. `holdFocus` in `focus.ts` holds the three
  behaviours:
  - Tab and Shift+Tab wrap inside the dialog, over the controls that are not disabled and not in a
    hidden subtree. The send button in flight is disabled, so it leaves the cycle.
  - Escape closes, and stops at the dialog. The thread and the capture mode also close on Escape from
    a document listener, and one key press must close one thing.
  - Focus goes back to the element that had it before the open, if focus is still in the dialog or
    nowhere. A reporter who moved focus to the page keeps it there.
  - A Tab from the page while the dialog is open comes back in. A click on the page moves focus out,
    and that Tab never reaches the dialog's own listener, so a capture-phase listener on the document
    catches it. A focused element outside the cycle, such as a send button disabled in flight, counts
    as outside and wraps too (raised in review on PR #61).
  - Only the dialog opened last keeps Tab. The gear opens the panel over an open popover, and two traps
    would move focus back and forth, so `holdFocus` keeps the open dialogs of each document in order.
  - An Escape while focus is on the page stays the page's. A click on the page gives it focus, and the
    host's own menus close on Escape. Proposed in review and not taken: Tab still brings focus back,
    and Cancel still closes.
- The reset removes the browser's focus ring along with everything else, so `host.ts` restores one on
  `:focus-visible` for buttons, links and fields.
- While no widget dialog has focus, the capture mode consumes the arrow keys. It consumes an Escape
  only when it cancels the capture, so the page and the thread do not act on the same key press.
  Enter on the gear, or on any control of the widget other than the launch button, presses that
  control instead of selecting the highlighted element.
- The gear stops the capture mode before it opens the settings. The capture mode takes the arrows and
  Enter from a document listener, so a panel opened over it would lose them. For the same reason the
  capture mode leaves the keys to any dialog of the widget that has focus.
- The thread gives focus back to what opened it: its badge, or the entry of the detached-notes list.
  A render keeps that distinction, and moves focus to the rebuilt entry or badge of the same issue.
- A render rebuilds the pins, and the badge that had focus, or the badge of a focused thread, is a new
  node. Focus moves to the new badge of the same issue instead of falling to the page.
- The popover's opener is what had focus when it opened. With the keyboard, that is the launch button,
  because the capture walk moves a highlight and never focus. With a mouse, it is whatever the click
  on the page focused.
- The panel's name is `settings.dialog`, the popover's is `composer.dialog`. `messages.test.ts` holds
  every named part of the widget to a name of its own, in each bundled catalog.
- The thread is a dialog that is not modal. It opens with focus on its close button, because it is
  the last child of the overlay and far from its badge in the tab order, and it gives focus back to
  the badge on Escape or Close. A click outside closes it and leaves focus where the click put it.
- **`document.activeElement` is the host element** for a node focused inside the Shadow root.
  `deepActiveElement` reads through the root. happy-dom implements `ShadowRoot.activeElement`
  (measured), so the unit tests can check the real thing.

**The capture mode without a pointer.** The ticket called this the real hole: a keyboard could not
plant a note, because selection was a hit test at the pointer.

- Tab cannot do it: most elements a note is about, a paragraph or a card, are not focusable. The walk
  is an inspector cursor instead. Down and Up go to the next and previous element in document order,
  Left to the parent, Right to the first child; the two swap in a right-to-left language. Enter or
  Space selects, through the same path as a click.
- `CaptureEngine.grabbable` is the filter, and react-grab's `isElementGrabbable` is behind it: the
  element the pointer can land on is the element the keyboard can stop on. `isOurs` still applies, so
  the walk never lands on the widget or on chrome the page told it to ignore.
- The arrows are taken with `preventDefault` while the mode is on, or the page scrolls under the
  reporter. Enter and Space are taken only while an element is highlighted. Before that, Enter
  presses the launch button that has focus, which stops the mode.
- The cursor scrolls its element into view and the host's live region names it: the tag, then the
  text or the `aria-label`, cut at 80 characters. Starting the mode announces how to use it.
- The walk stays in the light DOM of the document. The pointer's hit test also enters open shadow
  roots and same-origin iframes; the keyboard walk does not.

**What is announced without a focus move.** The popover's status was already a polite live region, for
planting, harvested and failed. The host adds one for the capture mode. The detached-notes list adds
one for its count, and announces only an increase. That region is a sibling of the list's root: the
root is hidden while the list is empty, and a live region in a hidden element announces nothing.
`owns` includes it, or the overlay reads its new text as a page change and resolves again.

**Where a screen reader meets the widget.** The ticket left this open. The widget mounts at the end of
`body`, so a screen reader reads it after the host's content, with no warning. The choice is a named
landmark: the host container is `role="region"` with `aria-label` from `widget.label`, so the widget is
listed with the page's landmarks and says what it is. Hiding it until activation was not taken: the
launch button is the activation, and it has to be reachable.

A pin lets clicks through, and only its badge is a control: a `button` whose `aria-label` carries the
stage and the note. The pin itself has no role, so a screen reader reads one button per note and
nothing for the frame around the element.

**Contrast**, measured with the WCAG 2.2 formula on the default tokens:

| Pair                                        | Where                         | Light        | Dark |
| ------------------------------------------- | ----------------------------- | ------------ | ---- |
| `on-accent` on `accent`                     | launch and send labels        | 4.23         | 4.23 |
| `accent` on `surface-raised`                | failed status                 | 4.16         | 3.73 |
| `accent` on `surface`                       | detached-note links           | 4.23         | 4.14 |
| `warning` on `surface`                      | approximate-position warning  | 4.62         | 3.78 |
| `on-stage` on seeded, green, ripening, ripe | the `≈` on an approximate pin | 2.28 to 4.23 | same |

Token names of before FRU-355 (`seeded`, `green`, `ripening`, `ripe`, `composted`): they are
`new`, `todo`, `progress`, `done` and `closed` since, see [stage-names.md](stage-names.md).

Text needs 4.5:1. Three values changed, because the old ones failed and nothing else paints with them:

| Token                        | Was              | Is        | Now measures             |
| ---------------------------- | ---------------- | --------- | ------------------------ |
| `color-text-subtle`, light   | `#a8a29e` (2.52) | `#7a736e` | 4.66 on `surface`        |
| `color-text-subtle`, dark    | `#78716c` (3.65) | `#8f8883` | 5.01 on `surface`        |
| `color-success`, light       | `#7cb342` (2.47) | `#4e7d2a` | 4.82 on `surface-raised` |
| `color-border-strong`, light | `#d6d3d1` (1.49) | `#8f8883` | 3.49 on `surface`        |
| `color-border-strong`, dark  | `#4a4441` (1.83) | `#7a736e` | 3.75 on `surface`        |

The dark scheme keeps `#7cb342` for `color-success`, which measures 6.29 there. A field's border needs
3:1 because the field's background is the surface around it, so the border is the only thing that
shows where to type. The popover's textarea moved from `color-border` to `color-border-strong` for the
same reason.

**What the token arithmetic did not see.** The first axe run in the dark scheme found text painted
black on `#1c1917`, at 1.2:1: the thread's state and note, the panel's title, its two fields and every
checkbox label. In the light scheme the launch label was black at 16px and weight 400, under a button
that declares white at 13px and 600; black on the accent passed, black on the chip of the capture mode
measured 2.04. The cause is the reset: `all: initial` sets `color` to its initial value, black, and
`font-size` to 16px, so an element with no rule of its own inherits nothing from its parent. The reset
now declares `color`, `font` and `letter-spacing` as `inherit`, and `:host` gives the first values.
`contrast.test.ts` compares tokens, and the painted colour was not a token, so only a measurement in a
browser could find this.

Two more findings from the same run:

- `font: 600 13px/1 inherit` on the popover's buttons was not a valid declaration, because `inherit`
  cannot be a family inside the shorthand. The browser dropped it, and Cancel and Plant were 16px.
- The thread's `<header>` became a banner inside the widget's region landmark, which axe refuses
  (`landmark-banner-is-top-level`). It is a `div` now.

After the fix, axe reports the accent only: the launch label and Plant, white on `#e53935`, at 4.22,
and the thread link at 4.22 in the light scheme and 4.13 in the dark. The spec lets those through and
fails if none is found, so the filter goes when the accent changes. The scan emulates
`prefers-reduced-motion`: the popover opens with an opacity animation, and axe measured the text of a
popover still fading in.

The accent and the stage colours are the product's identity, and they were left for a decision rather
than changed here. `contrast.test.ts` listed their failures exactly, so a fix removed an entry and a
new failure had to be added on purpose. A pin sits on the host's page, and no test here can promise
its contrast.

**The decision came with FRU-93, and the list is empty.** The palette is the one a Claude Design
mock-up proposed, taken because every value measured above 4.5:1 with white text:

| Token             | Before    | White on it | After     | White on it |
| ----------------- | --------- | ----------- | --------- | ----------- |
| `color-accent`    | `#e53935` | 4.23        | `#dd2c27` | 4.70        |
| `stage-seeded`    | `#a3b18a` | 2.28        | `#6a7950` | 4.70        |
| `stage-green`     | `#7cb342` | 2.50        | `#56802e` | 4.64        |
| `stage-ripening`  | `#fb8c00` | 2.37        | `#ac5f00` | 4.78        |
| `stage-ripe`      | `#e53935` | 4.23        | `#8c1d40` | 8.88        |
| `stage-composted` | `#8d6e63` | 4.62        | unchanged | 4.62        |

Token names of before FRU-355 (`seeded`, `green`, `ripening`, `ripe`, `composted`): they are
`new`, `todo`, `progress`, `done` and `closed` since, see [stage-names.md](stage-names.md).

As text on the two light surfaces, the accent measures 4.70 and 4.63.

- **The mock-up gave no dark scheme, and the light values cannot serve there.** The accent is a fill
  under a label and also the colour of a link on the surface. On `#262220` the light accent measures
  3.35 as text, and no red is both readable there and dark enough for white text: a search over the
  lightness of both reds found none. So the dark scheme takes a lighter fill, `#ec6a65`, with
  `#1c1917` on it: 5.68 as a label, 5.12 as a link on the raised surface. The warning has the same
  two roles and takes `#a88a7e` with dark text, 5.50 both ways.
- **The stage colours do not change in the dark scheme, but one.** A pin sits on the page of the host, whose
  colour follows nothing here. The stage colour is also the mark of a detached note and the drop in
  the head of a thread (its top border until FRU-256), on the surface: a drawing, which needs 3:1, and measures 3.27 at least on the
  dark surface. `contrast.test.ts` holds that pair now; it did not before.
- **Axe found a defect in this very change.** While capturing, the launch button takes the chip as
  its background and kept the foreground of the accent. Both were white, so nothing showed. With a
  dark foreground on the accent, the label measured 2.29 on the chip. The rule sets `color-on-chip`
  now. `contrast.test.ts` had the pair in its list and passed: it compares two tokens and cannot
  know which rule uses them.
- **The exception in `e2e/a11y.spec.ts` is gone, and a control took its place.** The spec let the
  accent through and failed if no accent finding came back. With nothing to let through, an empty
  list would prove nothing, so the last step paints a grey label on the accent and expects axe to
  object. Not the colour of the button itself: axe reports a 1:1 pair for review, not as a failure.
- **« Done » is a burgundy, and no longer the red of the accent.** The mock-up gave both `#dd2c27`,
  as the first palette gave both `#e53935`: a ripe fruit is red. A pin that reads as an alert when
  the work is done was the objection, and Mathieu chose burgundy: `#8c1d40` in the light scheme.
  On the dark surface that measures 1.97 as the mark of a detached note, so the dark scheme takes
  `#bd3a5c`: 3.27 there, and 5.35 under white text. It is the one stage with two values.
- **The extension's icon keeps `#e53935`.** It is five committed PNG files, drawn on a toolbar the
  widget's tokens do not reach.

## Re-anchoring, and why a pin says how sure it is

- `resolveAnchor` walks the anchor's claims in the order `SEED_ANCHOR_STRATEGIES` declares:
  **selector → testId → text → domPath → bounds**. That order is the contract's, and it puts `text`
  ahead of `domPath` deliberately.
- **Every match must be unique and of the captured tag**, and `domPath` must additionally still be
  roughly where the seed said it was — a structural path always resolves to _something_, and after
  an insertion that something is the neighbour.
- **Detached is not the same as unsure** (FRU-12). A pin found only by `bounds` is still placed,
  dashed, and marked unconfident — that is FRU-11's answer and the orphan list does not touch it.
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
- **It also watches the page, because nothing announces a re-render** (FRU-21). A `MutationObserver`
  on `childList`/`subtree` re-resolves every pin, debounced, and a `ResizeObserver` on each anchored
  element catches what moves without the structure changing. Deliberately **not** `attributes`: a
  design system toggles classes on every hover, and an element that merely changed class is still
  where it was — what must be caught is the element being _replaced_, which is always a childList
  change.
- **`resolve()` is not `render()`.** `render` takes new data and rebuilds, which closes the thread;
  `resolve` keeps the pins and the open thread and only updates what was _found_. A page that mutates
  while someone is reading a note is the normal case on an SPA, so slamming the thread shut is not an
  option. It re-applies the confidence marks too: a pin that fell from `selector` to `bounds` used to
  keep claiming it had been recognised, because those were written once at build time.
- **Take `MutationObserver` and `ResizeObserver` off the document's own window**, never off
  `globalThis` — the same realm rule as `isElement`. Reading the global gets Node's (which has
  neither), and the widget then watches nothing at all, silently. A unit test caught this; nothing
  else would have.
- **Pins let clicks through**; only the badge is clickable. A widget that swallows the client's own
  buttons is one they turn off.
- **Several notes on one spot fan their badges out** (FRU-155), one step of 30 px (a 28 px drop and
  a 2 px gap) to the right for each note before it, in render order (FRU-304; to the left from
  FRU-158 to FRU-304). Before, the badges lay on one
  point: one drop showed, and only the last one took the click. Each note keeps its own drop, its own
  stage colour and its own thread, so a reviewer counts the drops and opens each one; no count badge,
  no shared thread. The key is the point of the drop, rounded to the pixel, and not the element:
  two elements of the same box (a wrapper and its only child) hide each other just the same. The
  fan stays physical, like the pin, in both reading directions. `e2e/pin-stack.spec.ts` plants three
  notes on one button and reaches each badge with the pointer. Open question in the ticket: a count
  on one pin, if a spot ever carries more notes than its element is wide.
- **A pin does not cover what it annotates** (FRU-158, FRU-304).
  - **The drop stands above its element and covers nothing of it**: its point is on the top edge.
    FRU-158 had put the badge outside the top-left corner, turned by -90deg, because above an element
    is where its label or its price is written, and the badge hid the first digit of « 19 € ». The
    mock-up of 2026-10-20 points the drop down at the element, and FRU-304 follows it: text written
    less than 34 px above an element can be under its drop again. The frame of the note, under the
    pointer, says which element it is about. Arbitrated by the agent on 2026-10-20, and put to the
    orchestrator.
  - **The frame shows only while its badge is pointed at or focused, or its thread is open**,
    through `:has()`. Left on, it lined every annotated element, and a page with many notes became
    hard to read. A browser with no `:has()` shows it for an open thread only.
  - `e2e/pin-placement.spec.ts` checks that no drop is over its own element, and that every drop is
    on the page.
  - Open question in the ticket: a key or a dock button to see the bare page for a moment.
- `createOverlay({ host })` takes where to render. It defaults to `<body>`; FRU-3's Shadow root
  passes itself there, which is what finally isolates these styles.
- Tests run against **happy-dom** (`dom.fixture.ts`), a devDependency of this package only —
  uniqueness and sibling questions cannot be answered honestly by a hand-rolled fake. Nothing outside
  `*.test.ts` and `*.fixture.ts` may import it, and `tsconfig.json` excludes both so the shipped code
  still compiles with `types: []`.

## The list of every note (FRU-129)

### The rules, in short

- **`sidebar.ts` lists what `overlay.resolutions()` holds**, so it costs no request and leaves out a
  stage the reporter hid, like the copied text. A button of the dock opens it. Choosing a note
  calls `overlay.select(id, home)`, which scrolls to the element and opens its thread **in the
  column of the list, in place of the rows** (FRU-312). The thread on the page covered the rows at
  1440 px and the head of the sheet at 390 px. The head of the list stays; « All notes » (« Toutes
  les notes »), Escape, the cross of the thread or a click on the page bring the rows back, with
  focus on the row of the note. The thread there has no place, no border and no shadow of its own
  (`data-fruitback-home`). A thread opened from a pin still opens on the page.
- **It is a dialog that is not modal**, like the thread: the page stays usable beside it and a
  reviewer goes from note to note. It takes focus, gives it back to what opened it, and keeps its
  own Escape: the thread closes on an Escape of the document, and one key must close one thing.
- **Its name must not start like the thread's.** The two are open at once. « Feedback of this page »
  beside « Feedback DEV-3 » made one locator find two dialogs, in the first run of its spec.
- **No answer is not an empty list** (FRU-153). `embed.ts` keeps a `ReadState` for the page:
  `pending` until a read answers, `read` once one did, `failed` when none did and the last one
  failed. A navigation starts again at `pending`. Only `read` may show the empty state and a count
  of zero. `failed` says the notes could not be read, in a live region, and offers « Try again »,
  which takes focus. The button stays, busy (`aria-disabled`), while the read it asked for runs, so
  focus does not leave it and a second failure finds it. A failed read after a good one changes nothing, so the pins stay.
- **`failed` is seen on the page, with no list opened** (FRU-316). The button of the list wears a dot
  of the accent, ringed by the button's own colour (`Mark` in forced colours), and its name says it:
  « Show every note in a sidebar. They could not be read. ». The sentence of the list is announced
  once by the widget's own status region, when the failure starts and no capture holds that region.
  While `failed`, the widget reads again every 30 s and at once on `online`; one timer at most, none
  after `destroy` (a read in flight answers after it: without that guard a destroyed widget read on
  for ever, and `embed.test.ts` never exited). `e2e/read-failure.spec.ts` takes the browser offline,
  then online.
- **The playground does not have it**: it assembles the widget part by part. `e2e/sidebar.spec.ts`
  loads the built script, like `package.spec.ts`, and runs axe in both schemes with its own control.
- **It is the board « Sidebar mode » of the mock-up of 2026-10-20** (FRU-308), after the list of
  2026-10-13 (FRU-259). Read in its CSS, held by `e2e/sidebar.spec.ts` on computed styles and boxes
  at 1440 × 900.
  - **It lies over the page and does not push it** (A19). The board narrows its example site to
    1048 px. A margin on the page of somebody else breaks a layout nobody here read, so the panel is
    `position: fixed`, 392 px on the end edge (380 before, 340 before that), with the border, the
    shadow and the type of the board. The spec measures the page before and after, and its control
    is the margin of the mock-up.
  - **The head**: the drop of the accent, « Notes » and « · {host} », then « Back to floating
    pins » and the cross « Close the sidebar ». Both close the list. The board draws two buttons,
    and the widget has one state besides the list: the floating pins. The dialog keeps the name
    « Notes on this page »: « Notes » alone starts like « Note 3 », the name of a thread.
  - **« This page · 8 » alone, and no « Whole site »**: the script reads the notes of this page
    only (`GET /feedback` by page), and has no route for the site. Drawn as the chosen part of the
    rail of the board, as words: a list of one tab chooses nothing. No number until a read answered.
  - **« Search notes »** reads the whole text of each note and the identifier of its store, in any
    case, in the notes the widget holds: no request. Its keys stay in the field: a site and the
    capture mode listen on the document. Escape still closes the list.
  - **The chips of the statuses replace the tabs of FRU-259**: « All », « New », « To do », « In
    progress », « Done », each with its number, `aria-pressed`, one at a time. « Closed » is not on
    the board: its chip shows while a note of the page is closed. The numbers count what the search
    found, and what the overlay draws: a stage the reporter hid in the settings is in no chip, like
    the copied text. The detached notes are in no number: they have their own, at the bottom.
  - **A row of the board**: the drop of the pin (24 px, its number in white), « {Status} · {ID} … {when} »,
    the note cut at two lines, and « {who} · {n} replies » or « no reply », then « Approximate
    position » when it is the case.
  - **« further down »** when the top of the frame of the note is under the bottom of the window
    (`overlay.below`). The list follows the page while it scrolls, a frame behind at most, and
    listens to nothing while it is closed.
  - **The row of the note whose thread is open** says `aria-current`, and is the open card of the
    board: the warm surface and a line of the border inside it (`overlay.openId`, and `onThread`).
  - **The open row of the board is the thread in the column (FRU-312)**, not a card that grows in
    the list: the thread holds the block of the selector, the replies, « Reply » and the way to the
    store, which the card of the board shows in part. Its element has the ring of the board while
    its thread is in the list: the frame of its pin, 12 px round, with a halo of 6 px
    (`data-fruitback-choosing` on the overlay), and the other pins at 0.55.
  - **« 1 detached note »** holds the notes whose element is gone, at the bottom, in the dashed
    cards of the board: the note, then « {Status} · {ID} · the element it pointed at is gone ». Each
    one is a button: it still opens its thread. The title is in the muted text, not the brown of the
    board, which is 3.8:1 on the dark surface. The chips filter them too. The chip of `orphans.ts`
    on the page is unchanged.
  - **The foot**: « Leave feedback », 44 px, with the label of the host, which closes the list and
    starts a capture; and « Show pins on the page », a switch (`overlay.showPins`). Off, the pins go
    while the list is open, and the ring of the chosen note stays; the list shows them again when it
    closes, so no state of the widget is left with no pin and no list.
  - **The dock stands aside while the list is open** (`data-fruitback-listing` on the host of the
    widget), as drawn: the panel covers its corner. The gear is back at the close.
  - **Kept, though the board does not draw it**: the three states of a read; the notes kept for
    later, at the head of « All »; « No note matches. » for a search or a chip that keeps nothing;
    the sheet at the bottom of a phone, 70 % of its height at most; the dark scheme; 44 px for a
    thumb.

## Notes kept for later, and sent together (FRU-124)

### The rules, in short

- **« Keep for later » is a second action of the composer**, beside « Send », which keeps its
  meaning. It is there **for everybody**, and only while the last read offered a batch
  (`batch: { max, maxBytes }`, the worker half of #171). Arbitrated by the orchestrator on
  2026-10-12, on delegation from Mathieu: the ticket listed this option as recommended, and set aside
  a mode « several notes » to switch on (one more state, and a note one believes sent is not) and a
  draft forced from the second note (« Send » would change its meaning unasked).
- **A draft is a whole seed**, built when it is kept: the element, the place and the picture are
  those of that moment. The picture is the address the host already uploaded, so a draft holds no
  image of its own.
- **`sessionStorage`, per tab** (`drafts.ts`), under `<configKey>:drafts`: the drafts outlive a reload
  and a navigation in the tab, and go with the tab. A storage that refuses keeps them in memory for
  the page. A stored value is read through `parseSeed`: what is not a seed is dropped, because the
  worker refuses a whole batch for one thing that is not a seed.
- **On its page, a draft is a pin** with a neutral colour (`--fruitback-color-text-muted`), the mark
  `data-fruitback-draft`, and a thread that says « Not sent yet », with no identifier and no link. No
  stage the reporter hid hides it. It is not in the list of notes, nor in the copied text.
- **The list of every note has a group « Kept for later, not sent yet »** above the notes, with the
  drafts of every page of the tab and one button, « Send the N notes ». No board draws it: it is
  made of the parts of the list. A board is still to ask the design for.
- **As few requests as the worker allows** (`cutIntoRequests`): one place for each request, because
  `?destination=` is for the whole batch, then the number and the bytes the worker offers. A worker
  that offers no batch gets one seed for each request, never an array.
- **Only the notes answered « kept » leave the drafts.** After a `207` the others are sent again, never
  the whole batch: the worker protects a kept note against a second copy for ten minutes, one minute
  when its `Kv` refuses the trace. A request that fails stops the others and its sentence is the one
  of the composer for the same cause; nothing is lost. When some notes went and some stay, the list
  says both: how many were sent, then why the others stay.
- **A draft follows the places of now** (`withPlacesOfNow`). A member kept a note for a place the
  team took away since: the worker refuses it there at every try, and nothing in the list changes a
  place. So a place no longer offered falls to the first one, as the composer does at the second try
  of a single note, and a failed send reads again so the list of places is the one of now.
- `e2e/drafts.spec.ts` keeps two notes, reloads, sends them from the list in one request and reads
  them back from the worker; a `429` keeps the draft and says why; axe in both schemes.

## The note being written, saved as it is typed (FRU-311)

### The rules, in short

- **Each change of the field is saved**, for its page and its element (`typing.ts`), in
  `sessionStorage` under `<configKey>:typing`: per tab, like the drafts, for the same reasons. A
  storage that refuses keeps the text in memory for the page. Twenty texts a tab at most.
- **Esc, « Cancel » and the cross close and keep the text.** No question, no modal: the gesture stays
  quick (arbitrated by the orchestrator on 2026-10-20, FRU-310, with the audit's option A). The
  composer opened again on that element gives the text back and says « Draft restored »
  (« Brouillon restauré »), in the muted status line, until the person types.
- **A reload, or a navigation back to the page, opens the composer by itself** on the element of the
  text written last on that page (`restoreTyping` in `embed.ts`), with the text and the same
  sentence. The element is found as a pin is, **and only by its identity**: a text must not come back
  on the element that took the place of its own. Once for each visit of a page, never over somebody
  who writes, chooses or reads a thread, and never before a link to a note, which the address asked
  for. Never once the person chose an element on that visit: a text whose element
  came late does not reopen over the note they left since (review of #372).
- **A note sent, or kept for later, leaves**, for the element it was sent about: the composer can be
  open on another one when the answer comes. A field emptied by hand leaves too: that is the way to
  give a text up. A composer opened and closed with nothing typed writes nothing.
- **Pointed at another element while open, the composer keeps its text** (FRU-258), and the saved text
  moves with it.
- **`init` does it.** A host that assembles the parts itself (the playground) passes `autosave` to
  `createComposer`, or saves nothing, as before.
- `typing.test.ts`, the `autosave` tests of `composer.test.ts`, and `e2e/composer-autosave.spec.ts`
  (a reload, Esc, « Cancel », the cross, and the witness that another element opens empty and that
  nothing typed saves nothing).

## A site whose notes are « Members only » (FRU-330)

### The rules, in short

- **Only `canWrite: false` closes, and only from the worker's read.** The answer of a read, or its
  `401`, says it; absent, a note is offered, as by every worker of before. A refusal that does not say
  it, a body that is not JSON, and a read that fails for another reason change nothing.
- **Closed, no note starts**: the launch button reads « Notes from members only », is
  `aria-disabled`, and a press says « Only members of this site leave notes here. Ask its team to
  invite you. » in the live region. `host.closeNotes` makes `start` a no-op, so no other way in (the
  list, « Pick again », `leaveFeedback()`, which answers `false`) starts a capture. The list hides its
  « Leave feedback ».
- **A host that signs in keeps its own offer.** With `onSignIn` (the extension), the widget closes
  nothing: a refused read there is a session that ended, and `signedOut` offers the sign-in.
- **What is written stays**, as for FRU-315: a draft stays in its store, an open composer stays open.
  **A text written before comes back in a composer only once a read said that a note can be sent**
  (raised in review): `restoreTyping` waits for a read that is not stale, and does nothing while the
  notes are closed. The text waits in its store, and comes back when the site opens again.
  `embed-closed.test.ts` holds each rule; each was planted out and seen red.

## A note or a read refused for want of a member (FRU-394)

### The rules, in short

- **A `401` whose `error` is `identity-required` is « Members only », not « session ended ».** The
  worker answers it to a page that sent no token, or a token that names nobody of the workspace, on a
  site whose notes are « Members only » (`attributionFor`, `authorizeRead`). There was no session to
  end: the composer says « This site is for members only. Your text is kept: sign in to Fruitback
  from the extension, then send it again. » Any other `401` keeps the words of FRU-193.
- **The read says it too.** Refused that way, the list and the live region say « This site is for
  members only. Sign in to Fruitback from the extension to see its notes. », and the list offers no
  « Try again »: a second read at once is refused the same way. It reads again as a failed read does
  (every 30 s, and when the network is back), since an admin can open the site meanwhile. Outside the
  list, `notesState()` says `failed`, the state the side panel of the extension knows.
- **A `403` keeps its sentence** (« tell the team of the site »): the worker answers a note `403`
  for the origin of the page or a place that is gone, never for an account. « Your account cannot
  leave notes here » would say something the worker did not.
- The text stays in the field in every case. `send-refused.test.ts` sends through `plant`; on `main`
  of before, its `401` case said « Your session has ended ».
- Measured on 2026-10-23: the « try again » seen in production was the composer of a 0.1.0 copy of
  the extension, installed beside the 0.3.0 one (FRU-397). The 0.3.0 already said « session ended ».

## A session of the host that ended (FRU-315)

### The rules, in short

- **`init({ onSignIn })` and `widget.signedOut(ended)`.** A host that can tell the session it reads
  with has ended (the extension can) says so; the widget then offers `onSignIn` instead of a note:
  the launch button reads « Sign in to leave notes » and loses `aria-pressed` (it is no switch
  then), the list says « Sign in to see the notes of this page. » with « Sign in », and a send refused
  with `401` offers « Sign in again » beside its sentence. The composer asks for no name, and « Keep
  for later » stays offered so a text outlives the sign-in. `leaveFeedback()` leads to `onSignIn`.
- **What is written stays.** An open composer stays open with its text; nothing is built again.
- **Back, the widget reads the page again**, from a read and not from what it held.
- **Without `onSignIn`, `signedOut` does nothing**: a site's own widget has no sign-in to offer.
- No new colour: the same pill, the list's own block of « Try again », a ghost button of the composer.

## A link that opens a note on its page (FRU-253)

### The rules, in short

- **`<page>#fruitback-note=<id>` opens the thread of that note**, as a click on its pin does: the
  page scrolls to the element and focus goes into the thread. The console writes this link under
  « Show on the page ». The id is the id of the note, the id of its issue or its identifier.
- **Only after a read answered** (`openLinked` in `embed.ts`, called at the end of each read). The
  note is looked for among the notes the worker gave this reader, so the link opens nothing that
  `GET /feedback` did not answer: a refused read opens nothing and says nothing. `SECURITY.md` has
  the sentence.
- **Its part of the fragment is then taken out of the address**, found or not, with
  `history.replaceState`: a reload does not open the note again. **The fragment of the site
  stays.** `#pricing` is neither read nor changed, and `#pricing&fruitback-note=sd_1` leaves
  `#pricing` (`linkedNote` and `withoutLinkedNote` in `page.ts`).
- **That edit of the address asks for no read.** `watchUrl` hears every `replaceState`, ours too,
  and a read draws the pins again and closes the thread that just opened: found by the unit test
  that counts the reads. A fragment that arrives later on the same page is followed with the notes
  in hand, for the same reason.
- **Nothing takes focus from somebody who writes** (rule 3 of `CLAUDE.md`). While the composer is
  open or a capture runs, the link waits in the address. The note opens when the composer closes
  (`embed.ts` watches its `hidden`), or at the next read.
- **A note whose element is gone opens the list too**, on its group of detached notes
  (FRU-259, FRU-308), and its thread at the place it was planted.
- **A note this page does not draw opens nothing**: a note of another page, or of a stage the
  reporter hid in the settings. No error is shown and none is written to the console.
- `e2e/deep-link.spec.ts` opens a note by its link on the built widget, with its control (`#formules`
  is neither read nor erased), an unknown id, and a composer that stays open.

## A way in for a host: choose, list, count (FRU-254)

### The rules, in short

- **The handle of `init` has three more methods**, for a host that has its own way in, as the
  extension's popup does: `leaveFeedback()` starts choosing an element, as the launch button does;
  `showEveryNote()` opens the list of the page; `pageCounts()` gives the notes the page shows, by
  stage.
- **`leaveFeedback()` does nothing while a note is written**, and says so (`false`): nothing takes the
  place of what somebody types. A composer that only says « sent » closes. While an element is chosen
  already it answers `true` and starts nothing over. It closes the list first.
- **`pageCounts()` reads what the last read gave, and asks nothing.** Nothing until a read of this page
  answered, since zeros would say there are no notes; a stage the reporter hid is not on the page, so
  it is not counted. test:`counts the notes the page shows by stage, from the last read, and nothing before one (FRU-254)`.

## A picture asked for and not taken is said (FRU-238)

### The rules, in short

- **A note never loses its picture in silence.** When the reporter asked for a picture and the host's
  `captureScreenshot` gives none, or throws, the note goes without it, and the composer says « sent,
  without the picture » instead of « sent » (« kept for later, without the picture » for a note kept
  for later). `plant` answers `{ picture: 'missed' }` then. A picture
  the widget does not take on purpose (the page changed under the place, FRU-152) is not missed.
- In the extension, a picture refused for its token (`401 identity-required`, a token minted before
  the worker names its session) renews the access once and is sent again (`renewAccess`); refused
  again, it is missed, and said.

## A reply from the thread of a note (FRU-257)

### The rules, in short

- **The foot of a thread holds a field to reply when the worker says the reader may** (`canReply`
  of the read, set from every answer like `identified`) and the host did not say never
  (`replies: false`). Not under a note kept for later: it has no issue to answer.
- **`ReplySeam` is the seam, like `onSubmit`**: the overlay does not know the worker. `embed.ts`
  posts through `transportFor`, so the relay of the extension carries it.
- **What a person typed is never lost.** A failure keeps the text and says why. The text lives in a
  map by note too, because a resolve and a render build the thread again under it.
- **A reply that the store kept is shown at once**, in the thread, with no read: a read draws the
  pins again and closes the thread.
- **Enter sends, Shift+Enter goes to the next line.** Escape closes the thread, as everywhere; the
  text waits for it to open again.
- **The name of a visitor is the one the reporter asked the widget to remember**, and none for a
  reader the worker names: the worker would not read it.
- **A reply from the page reads as a reply.** The worker writes a first line for the tracker
  (« **Bob** via Fruitback · not verified ») and quotes the text: the thread shows the name as the
  author, what the worker knows of the person beside it, and the text unquoted (`replyFromPage`).
  Another comment is shown as it was written. Somebody who comments in the tracker can type the same
  line and show another name on the page: they are people of the team of the site.
- **Two « Send » can be on screen**, the one of the composer and this one: this one is named « Send
  reply », and its visible word is in its name.
