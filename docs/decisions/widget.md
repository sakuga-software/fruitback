# The widget

The browser half: how a seed is captured, why everything lives in one Shadow root, what a host may
restyle, how a pin says how sure it is, and who carries the calls to the worker.

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
  stops their `button { width: 100% !important }` from reshaping our toolbar _and_ our rules from
  reaching their page. Neither direction is achievable with prefixed class names.
- `:host { all: initial }` on top, because a Shadow root blocks the page's _selectors_ but not its
  **inherited** properties — `body { font-family: Papyrus }` reaches in otherwise. The catch: `all:
initial` also undoes the browser's `display: none` on `<style>`, which then renders the stylesheet
  as visible text in the corner of the client's page. Hence `style, script { display: none }`. Both
  are covered by E2E tests, because neither is visible to a DOM emulator. The reset on every element
  inside stops inheritance too, so it declares `color` and `font` as `inherit` (SKG-544, in _The
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
  the widget (the dev toolbar today, SKG-503's config panel next). Note what it does not do:
  react-grab walks _past_ a rejected candidate, so hovering our own chrome highlights whatever is
  behind it. Harmless; capturing it would not be.
- **Never `instanceof Element` in this package.** It reads a class off one realm, and an element from
  a same-origin iframe — which react-grab returns on purpose — belongs to another. Use `isElement`
  from `dom.ts`.

## The look, and the one thing a host may change

- **`theme.ts` owns every colour, shadow, radius, font family and duration** (SKG-528, SKG-529). They were
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

- **`--fruitback-*` tokens, `.fruitback-*` classes, `data-fruitback-*` attributes.** One word
  everywhere (SKG-580), including the names on the `<script>` tag the README documents.
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
  explains the current name; the first pass of SKG-580 spared them mechanically and left a paragraph
  describing a distinction the code had stopped making, which is the worse failure — a comment that
  outlives what it described.
- **`init({ theme })` takes tokens, never CSS.** A host that could write a stylesheet into the Shadow
  root would turn our class names into a contract by accident, which is what the Shadow root exists
  to prevent. `applyTheme` writes only names `THEME_TOKENS` declares and silently drops the rest, so
  a token renamed in a later version costs that override and never the mount.
- **`public.ts` exports the theme _types_ and not `THEME_TOKENS`.** The runtime array would widen the
  published surface; `package.test.ts`'s `promises only what public.ts declares` caught that on the
  first attempt, which is what it is for.
- **The base `:host` block must declare every settable token**, and the test that checks it is scoped
  to that block. Searching the whole stylesheet passed a mutation that deleted a declaration, because
  the dark block redeclares it — a token declared only under `prefers-color-scheme: dark` is undefined
  in light mode.
- **Radii are tokenised now, and the order of the two moves is the point** (SKG-529). SKG-528 refused
  to name eight distinct values, because eight tokens each used once is indirection wearing the
  costume of a scale. SKG-529 shortened the scale first — 4, 6 and 8 became `sm`; 10 and 12 became
  `md`; 14 and 18 became `lg`; 999px is `pill` — and named the four that were left. Naming them before
  reducing them would have frozen the accident.
- The pin's silhouette is **not** in that scale: `border-radius: 50% 50% 50% 0` is a shape, not a
  corner size, and it is the product's identity rather than a preference a host may set.
- Spacing is still literal — nobody overrides it, and substituting sixty numbers is where a silent
  visual regression hides.
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

## Who carries the calls

- **`transport` is a seam, and it is the same one twice** (SKG-595). The widget stays dormant when a
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
- **One existing assertion changed, and it was asserting the mechanism.** `sends no Authorization
header when the host mints no token` compared `fetch`'s second argument to `undefined` — true only
  because the old code passed nothing there. Every call carries a method now, so it asserts the
  absence of the header, which is what its own comment always said it meant.
- **`identityToken` and `transport` overlap and are left overlapping.** In the extension's mode the
  relay holds the session, so the token seam is dead there; with no extension the transport is the
  default, so the relay is dead. Unifying them belongs with the extension side, not here, where there
  is nothing yet to unify against.

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
- **The panel offers a box only for the stages the worker reports** (SKG-525). The list arrives with
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

## The words, and the catalogs the bundle carries (SKG-530, SKG-531)

- **`messages.ts` holds every word the widget shows, behind a key.** No i18n library ships: a record
  of strings and `Intl.PluralRules` cost a few hundred bytes, under a size guard that trips at 150 kB.
- **English is the default, and French is bundled beside it** (SKG-531). The project is open source,
  so its default is the language most readers share. SKG-530 shipped English alone, and for that
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
  SKG-531), and carries the absolute date in its `title`. The absolute date follows the locale the
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
- **The link's arrow is a message** (`thread.link`), because a right-to-left catalog points it the
  other way.
- **Each bundled catalog weighs on the size guard.** If the list grows, catalogs load on demand; the
  guard is not widened.

## The keyboard, the screen reader and the contrast (SKG-544)

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

| Pair                                        | Where                          | Light        | Dark |
| ------------------------------------------- | ------------------------------ | ------------ | ---- |
| `on-accent` on `accent`                     | launch and send labels         | 4.23         | 4.23 |
| `accent` on `surface-raised`                | failed status                  | 4.16         | 3.73 |
| `accent` on `surface`                       | thread and detached-note links | 4.23         | 4.14 |
| `warning` on `surface`                      | approximate-position warning   | 4.62         | 3.78 |
| `on-stage` on seeded, green, ripening, ripe | the `≈` on an approximate pin  | 2.28 to 4.23 | same |

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
than changed here. `contrast.test.ts` lists their failures exactly, so a fix removes an entry and a new
failure has to be added on purpose. A pin sits on the host's page, and no test here can promise its
contrast.

## Re-anchoring, and why a pin says how sure it is

- `resolveAnchor` walks the anchor's claims in the order `SEED_ANCHOR_STRATEGIES` declares:
  **selector → testId → text → domPath → bounds**. That order is the contract's, and it puts `text`
  ahead of `domPath` deliberately.
- **Every match must be unique and of the captured tag**, and `domPath` must additionally still be
  roughly where the seed said it was — a structural path always resolves to _something_, and after
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
- `createOverlay({ host })` takes where to render. It defaults to `<body>`; SKG-492's Shadow root
  passes itself there, which is what finally isolates these styles.
- Tests run against **happy-dom** (`dom.fixture.ts`), a devDependency of this package only —
  uniqueness and sibling questions cannot be answered honestly by a hand-rolled fake. Nothing outside
  `*.test.ts` and `*.fixture.ts` may import it, and `tsconfig.json` excludes both so the shipped code
  still compiles with `types: []`.
