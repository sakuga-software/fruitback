# The dev loop and the E2E suite

Why the playground is a React app, what a cold Vite cache does to CI, and the four defects the
browser suite has already caught. The rules an agent needs before it writes a spec are in
[CLAUDE.md](../../CLAUDE.md); this is the reasoning behind them.

## The dev loop

**`pnpm dev` starts both halves. The ports are fixed, and these are them:**

|                         |                                     |
| ----------------------- | ----------------------------------- |
| `http://localhost:5177` | the playground page                 |
| `http://localhost:8788` | the worker, on its in-memory Linear |

`8788` and not `8080`: 8080 is the container's port, and something is usually already sitting on it
on a developer's machine. `/tf` and `/tfp` read these numbers from here rather than probing.

- **`FRUITBACK_STORE=memory` swaps the real Linear for `linear-memory.ts`**, so the whole loop —
  capture, issue, pins coloured by state — runs with no API key and writes to nobody's workspace. It
  is refused under `NODE_ENV=production` (which the Dockerfile sets), `/health` answers
  `{ ok: true, store: 'memory', openRead: 1 }` (measured on `dev:fake`, SKG-543: it sets no
  `FRUITBACK_READ`, so reads are public), and the boot log says so. `FRUITBACK_FAKE_LINEAR=1` is the older
  spelling, still works, and now says at boot that it is deprecated — see _Which store, and who
  validates it_ ([worker.md](worker.md)). It is
  **not** a mock: an issue is stored as the description `buildIssueDescription` produces and read
  back through the same `toSeedIssue` as production, so a broken round trip breaks the playground
  too.
- **The playground is a React app on purpose, and it is the only place three things are true.** The
  widget mounts in an effect, so it arrives _after_ hydration. A client-side navigation changes the
  page identity with no page load to notice it. And `source` finally has a fiber to read, which is
  the half of a seed that says _which component_ a note is about. Each of those found a real defect
  the moment it first ran — see below.
- **A re-render used to be invisible to the widget**, and the playground re-resolved by hand because
  the host had caused it and therefore knew. A client's app cannot know, so SKG-513 moved that into
  the overlay: `fruitback.tsx` now only _reports_ what the widget decided, through `onResolve`. The
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
  a different string. `e2e/host.spec.ts`'s `the widget cannot restyle the page either` is the
  instance.
- **The rule generalises past colour: assert on what you measured, not on a second measurement.**
  Anything the widget takes away by itself has the same shape — the composer clears its confirmation
  1.1s after showing it, so waiting for `harvested` and _then_ reading the Shadow root again is two
  round trips with a deadline between them. Poll, and keep the value that satisfied the poll
  (SKG-529). Measured: the two-step form fails once 1.5s passes between the steps.
- It has already earned its keep four times: the browser caching `GET /feedback` and serving the
  widget its own stale answer right after planting a pin; `domPath` resolving cleanly onto the
  neighbouring card; React 19's `useId` format accepted as a stable id; and the fiber walk throwing on
  the `null` owner React ends every tree with, which stopped a click from planting anything at all.

## The extension under Playwright (SKG-538)

`e2e/extension.spec.ts` loads `apps/extension/.output/chrome-mv3`, which `pnpm e2e` now builds, into a
persistent Chromium context. Measured on Chromium 151 before the specs were written:

- **The headless shell loads no extension.** With `--load-extension`, no service worker started in 10
  seconds. The full Chromium in its new headless mode (`channel: 'chromium'`) started one at once.
- **A permission prompt cannot be answered from automation.** `permissions.request` from the service
  worker rejects with `This function must be called during a user gesture`. From an extension page,
  inside a click, it stays pending, and `permissions.contains` stays false.
- **A host permission in the manifest is granted at load.** A copy of the build with
  `host_permissions` for `http://localhost:5177/*` and `http://localhost:8788/*` answers `contains`
  true for both origins and false for any other. The fixture loads that copy, so the options page and
  the popup ask and get an answer at once. The grant alone mounts nothing: the no-rule spec has it.
- **`registerContentScripts` does not throw for an origin the extension does not hold.** It resolved.
  `background.ts` said it throws. The comment now says what was measured, and the
  `permissions.contains` check stays.

What the specs rest on:

- **The site is `/?case=…&widget=off`**, the playground without its own widget. The parameters are in
  canonical order, so the stored seeds are read with the raw URL. They are read from Node, so the
  page's own requests to the worker can be counted.
- **Team mode needs a site that ships a dormant widget**, and the playground has none. The spec
  mounts the built IIFE as such a site does: on `fruitback:extension`, with
  `window.fruitbackExtension.transport`.
- **The popup acts on the active tab of its window.** In a tab of its own it describes itself, so the
  spec opens it behind the site with `tabs.create({ active: false })`.
- **The two searches read different things.** `addScriptTag({ path })` puts the widget code in the
  DOM, and that code names the `Authorization` header. So the header search reads the bridge
  messages only. The token search reads everything the page can reach, and fails unless it finds a
  stored token in both `local` and `session`.
- **A select inside a label takes the chosen option into its name**, so the options page's mode field
  is found by `/^Mode/`.

Each guard was run against a mutant, and each mutant failed a check:

| Mutant                                                    | Failed on                       |
| --------------------------------------------------------- | ------------------------------- |
| `registration.ts` registers the page script in `ISOLATED` | the stored seed has no `source` |
| a stored token written to the page's `localStorage`       | the token search                |
| the site's widget mounted with no `transport`             | `reporter` is not `verified`    |
| the rule added before the no-rule assertions              | a widget host on the page       |
| `page.content.ts` declares `world: 'ISOLATED'`            | `worlds.test.ts`, not the spec  |

The spec passed on the last one, and that is not a weak spec. A script registered at runtime takes its
world from `registerContentScripts`, so the `world` in the entrypoint does not reach the browser.
`worlds.test.ts` finds the main-world files by that declaration, so it is the check that fails.
