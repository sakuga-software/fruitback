# The dev loop and the E2E suite

Why the playground is a React app, what a cold Vite cache does to CI, and the four defects the
browser suite has already caught. Each section opens with the rules an agent needs before
it writes a spec, in short; the reasoning behind them follows.

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
  `{ ok: true, store: 'memory', openRead: 1 }` (measured on `dev:fake`, FRU-50: it sets no
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
  the host had caused it and therefore knew. A client's app cannot know, so FRU-21 moved that into
  the overlay: `fruitback.tsx` now only _reports_ what the widget decided, through `onResolve`. The
  proof that the gap is really closed is that deleting the manual call left `reanchor.spec.ts` green
  — and that restoring the old overlay makes all three of its specs fail.
- The toolbar and `fruitback.tsx` are **scaffolding, not the product** — FRU-3/493 replace the
  capture UI, FRU-11 replaces the re-anchoring. Do not grow features there; grow them in
  `packages/widget`.
- `apps/playground/.react-router/` is typegen, regenerated on dev and build. It is ignored, not
  committed.

## The E2E suite

### The rules, in short

`pnpm e2e` (Playwright, `e2e/`) starts both servers itself and runs its specs against Chromium. It
builds `dist` first, because `package.spec.ts` loads the real file.

- **Assert on what you measured, never on a second measurement.** Poll until a value satisfies the
  check and keep _that_ value: a computed colour read mid-transition is the interpolated one (which
  Chromium serializes in another colour space), and the composer clears its confirmation 1.1s after
  showing it. Synchronise on the harness's status line rather than on a pin count — the old pins are
  still in the DOM while the new set is being fetched, so counting races.
- **An absence needs a control.** The no-rule spec then adds the rule and sees the widget; the token
  search fails unless it finds a token in both storage areas. A spec that counts zero proves nothing alone.

### The reasons, and the history

- It exists for the two things happy-dom cannot vouch for: a **real selector engine** and **real
  layout**. Everything else stays in `node --test`, which is where it is faster and clearer.
- Specs share one worker process, so each captures on **its own page URL** (`/?case=…`) — the seed's
  page identity is what keeps them apart. There is no reset between specs.
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
  a different string. `e2e/host.spec.ts`'s test:`the widget cannot restyle the page either` is the
  instance.
- **The rule generalises past colour: assert on what you measured, not on a second measurement.**
  Anything the widget takes away by itself has the same shape — the composer clears its confirmation
  1.1s after showing it, so waiting for `harvested` and _then_ reading the Shadow root again is two
  round trips with a deadline between them. Poll, and keep the value that satisfied the poll
  (FRU-36). Measured: the two-step form fails once 1.5s passes between the steps.
- It has already earned its keep four times: the browser caching `GET /feedback` and serving the
  widget its own stale answer right after planting a pin; `domPath` resolving cleanly onto the
  neighbouring card; React 19's `useId` format accepted as a stable id; and the fiber walk throwing on
  the `null` owner React ends every tree with, which stopped a click from planting anything at all.

## The extension under Playwright (FRU-45)

### The rules, in short

- **`extension.spec.ts` loads the built extension into a real Chromium** (FRU-45), and `pnpm e2e`
  builds it first. The fixture launches `channel: 'chromium'`: the headless shell Playwright uses by
  default loads no extension (measured). Automation cannot answer a host permission prompt, so it
  loads a **copy** whose manifest declares the playground and both workers. The shipped manifest still asks for
  nothing at install, and the no-rule spec runs with that grant.
- **The worker holds extension sessions during the suite** (`e2e/worker-sessions.ts`), and the team
  spec mints its code with the real `pair` command. The suite never reuses a worker already on its port: one started without
  that env holds no session store, or not that one. Stop `pnpm dev` before `pnpm e2e`. The team spec
  pairs with a **second worker on `8789`, with `FRUITBACK_READ=authenticated`**: on `public` a pin read
  back proves nothing about the relay, because the page could read it with no credential.

### The reasons, and the history

`e2e/extension.spec.ts` loads `apps/extension/.output/chrome-mv3`, which `pnpm e2e` now builds, into a
persistent Chromium context. Measured on Chromium 151 before the specs were written:

- **The headless shell loads no extension.** With `--load-extension`, no service worker started in 10
  seconds. The full Chromium in its new headless mode (`channel: 'chromium'`) started one at once.
- **A permission prompt cannot be answered from automation.** `permissions.request` from the service
  worker rejects with `This function must be called during a user gesture`. From an extension page,
  inside a click, it stays pending, and `permissions.contains` stays false.
- **A host permission in the manifest is granted at load.** A copy of the build with
  `host_permissions` for `http://localhost:5177/*` and `http://localhost:8788/*` answers `contains`
  true for both origins and false for any other. The fixture's copy now adds `http://localhost:8789/*` too, for
  the team-mode worker. The fixture loads that copy, so the options page and
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
- **Team mode runs against a second worker, on `8789` with `FRUITBACK_READ=authenticated`.** On the
  suite's `public` worker the reload would show the pin even if the relay sent no `Authorization` on a
  read, so the spec first asserts an anonymous read of that page answers `401`. Both workers share the
  session file, so the `pair` command needs no port.
- **The popup acts on the active tab of its window.** In a tab of its own it describes itself, so the
  spec opens it behind the site with `tabs.create({ active: false })`.
- **The two searches read different things.** `addScriptTag({ path })` puts the widget code in the
  DOM, and that code names the `Authorization` header. So the header search reads the bridge
  messages only. The token search reads everything the page can reach, and fails unless it finds a
  stored token in both `local` and `session`.
- **A select inside a label takes the chosen option into its name**, so the options page's mode field
  is found by `/^Mode/`.

Each guard was run against a mutant, and each mutant failed a check:

| Mutant                                                    | Failed on                           |
| --------------------------------------------------------- | ----------------------------------- |
| `registration.ts` registers the page script in `ISOLATED` | the stored seed has no `source`     |
| a stored token written to the page's `localStorage`       | the token search                    |
| the site's widget mounted with no `transport`             | `reporter` is not `verified`        |
| `relay.ts` sends no `Authorization` on a GET              | the pin read back through the relay |
| the rule added before the no-rule assertions              | a widget host on the page           |
| `page.content.ts` declares `world: 'ISOLATED'`            | `worlds.test.ts`, not the spec      |

The spec passed on the last one, and that is not a weak spec. A script registered at runtime takes its
world from `registerContentScripts`, so the `world` in the entrypoint does not reach the browser.
`worlds.test.ts` finds the main-world files by that declaration, so it is the check that fails.

## The public demonstration (FRU-79)

### The rules, in short

- **The public demonstration is this playground, served in development mode** (FRU-79):
  `demo.fruitback.com`, with its worker on `api.demo.fruitback.com`. A production build of the page
  loses the component and the file of a note (measured: `bound qi`, and a chunk of the bundle), and
  those two are the product. `apps/playground/Dockerfile` therefore runs a development server. It
  must hold no secret and no volume. Anybody can write to that worker: it keeps its notes in SQLite,
  holds no key of any tracker, and is emptied every night by `apps/playground/demo/reset.sh`, from
  the crontab of the host. Dokploy builds both applications from `main` on each push.

### The reasons, and the history

A reviewer of a browser store installs the extension and tries it. With no worker to reach and no
page to try it on, the extension does nothing, and that is a refusal. The same instance shows the
product to somebody without `pnpm dev`.

- **`demo.fruitback.com` is the playground, `api.demo.fruitback.com` its worker**, on em-sakuga-01
  through Dokploy (project `fruitback`). Dokploy builds both from `main` by their Dockerfiles. The
  worker is not pulled from ghcr: that package is private, and it was two weeks old on that day.
- **The playground runs in development mode, and that was measured, not preferred.** On a
  production build, a note planted on the « Ajouter » button carries
  `{ component: 'bound qi', file: '/assets/site-state-Bgn4uEnK.js' }`. In development mode the same
  click carries `{ component: 'Button', file: 'site.tsx', line: 58 }`. The component and the file
  come from metadata that only a development build of React keeps.
- **A development server on the internet is acceptable here for one reason: the container holds
  nothing.** No secret in its environment, no volume, and its files are this public repository.
  Vite refuses a `Host` it does not know (`PLAYGROUND_ALLOWED_HOSTS`) and a path outside the
  workspace (`/@fs/etc/passwd` answers `403`, measured). Do not copy this Dockerfile for a real site.
- **The worker holds no key.** SQLite, `FRUITBACK_READ=public`, `RATE_LIMIT_PER_MINUTE=10`,
  `ALLOWED_ORIGINS=https://demo.fruitback.com`, and no session path: a session needs an identity
  secret, and this instance must hold none. `TRUSTED_PROXY_HOPS=1`, because Traefik is in front:
  with 0, every visitor is Traefik, and they all share one limit of 10.
- **The store has no named volume, so a new deployment starts empty.** The image declares `/data`
  as a volume, and Swarm gives each new container its own. That is accepted for a sandbox. Do not
  copy it for a real worker.
- **It is emptied every night at 04:00, Paris time in summer** (`0 2 * * *` UTC, in the crontab of `mheos` on the
  host: Dokploy's MCP has no scheduled task). `apps/playground/demo/reset.sh` is the script. It
  deletes the rows with `sqlite3` in the running container, with `PRAGMA foreign_keys = ON` so the
  replies go with their notes (measured: 1 note and 1 reply before, 0 and 0 after). Removing the
  file does nothing: the worker keeps its connection. A container that took no note has no table
  yet, and the script says so and stops.
- **The socket of Vite goes through the proxy.** The page is on 443 and the server on 5177. The
  client opens its socket on the port of the server by default, which Traefik does not publish.
  When `PLAYGROUND_ALLOWED_HOSTS` is set, `vite.config.ts` sets `hmr.clientPort` to 443.
- **The name of the Swarm service is in the script.** Dokploy generates it. If the worker
  application is created again, the name changes and the script finds no container: it then exits
  1 and writes that in `reset.log`.
- **The toolbar says what the page is** when `VITE_FRUITBACK_DEMO_NOTICE` is set. The dev loop and
  the E2E suite do not set it.
- **What it does not show: team mode.** That mode needs sessions, and sessions need a secret.
