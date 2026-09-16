# No emoji, and what replaced them

SKG-529 took every emoji out of `packages/widget` and put four drawn glyphs in their place. Which
set, why a filled weight decided it, why Iconify is a source and never a runtime, and the two guards
that keep the generated file honest.

## No emoji, and what replaced them

- **Nothing in `packages/widget` renders an emoji** (SKG-529). A sprout opened the launch button, a
  gear sat on the settings chip, a fallen leaf on the detached-notes count, a strawberry on the
  confirmation. An emoji is drawn by the system's own font: the same codepoint is flat on Windows,
  glossy on macOS and something else on Android, it takes no colour, sits on no typographic grid, and
  carries a register that cannot be dialled down. A review tool laid over a client's site is seen by
  that client.
- **`icons.ts` holds all four glyphs**, built with `createElementNS`, sized in `em`, painted in
  `currentColor`, `aria-hidden` and `focusable="false"`. An SVG assigned through `innerHTML` is parsed
  into the HTML namespace and renders nothing at all, which is why `composer.ts` prepends its mark
  after the template rather than writing it into `TEMPLATE`.
- **Two of the four come from Phosphor and two are ours, and the split is the rule for the next one.**
  `gear` and `close` are generic affordances a maintained set draws better than we do. `drop` and
  `dropDashed` are the pin's own silhouette — the product, not its furniture — and no set has them.
  Reach for the set when the glyph names an action; draw it here when it _is_ Fruitback.
- **Iconify is a source, never a runtime.** `iconify-icon` and `@iconify/iconify` fetch their paths
  from Iconify's API on first render: a network call to a third party, from a client's page, by a
  widget whose whole argument is that it needs nobody's service. `build-icons.ts` reads the
  `@iconify-json/ph` devDependency at authoring time and writes `src/icon-data.ts`, which is
  committed so the widget builds with no generation step. Measured cost in `dist`: **+376 bytes
  gzipped**, against the 150 kB tripwire.
- **Phosphor, and the reason is its filled weight.** Measured at 14px on the settings chip, every
  stroked gear tried — `lucide:settings`, `tabler:settings`, `ph:gear` — collapses into a ring with
  bumps, while the filled ones stay legible. A filled weight is only worth choosing a set for if the
  _next_ icon has one too: Phosphor ships `-fill` for 1525 of its 1527 base icons, Tabler for 1056 of
  5144, Lucide for none. Counted, not assumed — and the first count was wrong because it divided by
  Phosphor's six weights rather than by its base set.
- **Paint travels as path attributes, not as CSS**, because that is how Phosphor ships its own. A
  `.fruitback-icon { fill: … }` rule is a class selector beating their `fill="currentColor"`
  presentation attribute, and every imported icon would render in the wrong colour or not at all. The
  stylesheet sizes them and stops there.
- **The generator formats what it writes, with the installed binary and never `npx`.** Without the
  formatting step, `pnpm icons:build` produces a file `oxfmt --check` rejects: running it alone
  reddens the `format` job, and the committed file is the formatter's version rather than the
  script's. A generated file nobody can regenerate byte for byte is a generated file that is really
  hand-maintained. And `npx` would have undone the fix it implements — it resolves against the
  caller's cwd and installs from the registry when it finds nothing, so a machine missing the local
  copy formats with another version and writes different bytes, silently. The bin is resolved out of
  its own `package.json` and run through `process.execPath`, which is the idiom `build.ts` already
  uses for `tsc`: no PATH, no shell, no package manager. Verified with `PATH=/nonexistent`. Both
  halves raised in review.
- **`icon-data.ts` is generated and committed, so something has to stop it drifting.** `icons.test.ts`
  reads `@iconify-json/ph` directly — not through the generator, so the two cannot share a parsing
  bug — and asserts each committed `d` appears verbatim in the installed set, plus that the recorded
  version is the installed one. Both mutation-tested: a hand-edited path and a stale version each
  fail with the message that names `pnpm icons:build`.
- **`*:not(svg, svg *) { all: initial }`, and that exclusion is the whole ticket's riskiest line.**
  Since SVG2 a path's own geometry is a CSS property, so a bare star selector computes `d: none` and
  `stroke: none` — every icon renders as an empty box, with nothing in the console and nothing a unit
  test can see, because happy-dom draws nothing either. Measured in Chromium before the code was
  written, and `e2e/host.spec.ts`'s _the icons are actually drawn_ was measured failing against the
  bare selector.
- **The fruit did not leave, it moved into the geometry.** `drop` is the pin's own silhouette — three
  round corners and one sharp — so the launch button plants the thing the page then shows; `dropDashed`
  is that shape drawn the way the overlay draws a pin it could not re-anchor, which is what the
  detached-notes chip now opens with. These two stay hand-drawn for the same reason the set covers
  the other two. An orphan row carries the same drop in its **stage's** colour,
  which is what finally made `orphans.ts`'s signature honest — it had been over-invalidating on a
  stage nothing rendered.
- **The gear was hand-drawn twice before it was borrowed, and that is the argument for the set.** The
  first attempt overlapped its tooth and valley angles and drew a spiky blob; the second was a
  passable filled gear. Both only revealed themselves when the icons were rendered at 4× and looked
  at. `ph:gear-fill` is better than either and cost nothing to maintain, which is exactly the work an
  icon set exists to absorb.
- **`≈`, `×` and `→` are not emoji and were judged separately.** They are typographic symbols with one
  drawing in every font. `≈` stays on an unsure pin — it is the whole warning in one character; `×`
  became the `close` icon because it was standing in for a drawing at 18px and aligning on no
  baseline; `→` stays on the thread's link.
- **A host's label is still the host's word.** SKG-529 took our emoji out of the widget's chrome and
  did not start filtering theirs: `e2e/package.spec.ts` **and** `e2e/screenshot.spec.ts` both mount
  with `label: '🌱 Feedback'` on purpose and assert it renders. What changed is the _documented_
  snippet, in `README.md` and `docs/install.md`, which no longer suggests one. The first version of
  this bullet named one file and called it the only one; run
  `grep -rnP "[\x{1F300}-\x{1FAFF}]" e2e` rather than trusting a number written here, which is the
  same rule the SKG-517 emoji inventory in _The seed contract_ ([contract.md](contract.md)) had to
  learn twice.
- **The guard is `icons.test.ts`'s test:`has none in any source file of this package`**, and it reads every
  `.ts` in the package rather than the rendered strings — a rendered check only sees the states a test
  reaches, and each of the removed emoji sat on a path some test did not run. `e2e/host.spec.ts`'s
  test:`no emoji survives anywhere in the widget chrome (SKG-529)` is the other half: it **drives** the widget
  through the dock, the settings panel, the open composer, the confirmation and the detached drawer,
  reading the composed Shadow root after each, because a popover that has closed leaves nothing to
  read. Both were measured failing on a planted emoji — the E2E one on `MESSAGES.harvested`
  specifically, which is the string the first version could not have reached.
- **That first version is why the presence markers are there.** It opened the settings panel, claimed
  to cover the composer, and guarded itself with "the text is not empty" — which passes before a
  single piece of chrome has rendered, because `textContent` on a Shadow root includes the CSS of
  every `<style>` in it. It now asserts each state's own words are present, so a passing emoji check
  is a check on something. Raised in review, both halves.
