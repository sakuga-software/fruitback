# The dev loop and the E2E suite

Why the playground is a React app, what a cold Vite cache does to CI, and the four defects the
browser suite has already caught. Each section opens with the rules an agent needs before
it writes a spec, in short; the reasoning behind them follows.

## The dev loop

**`pnpm dev` starts both halves. The ports are fixed, and these are them:**

|                         |                                            |
| ----------------------- | ------------------------------------------ |
| `http://localhost:5177` | the playground page                        |
| `http://localhost:8788` | the worker, on a PostgreSQL in its process |

`8788` and not `8080`: 8080 is the container's port, and something is usually already sitting on it
on a developer's machine. `/tf` and `/tfp` read these numbers from here rather than probing.

- **The worker of `pnpm dev` is `apps/worker/src/dev-worker.fixture.ts`** (FRU-223): the server of
  `main.ts`, on a PostgreSQL in the process (PGlite), with no Docker and no variable. It applies the
  migrations, makes one workspace and one site, `playground`, at `http://localhost:5177`, and starts.
  A worker with a database serves the sites of its workspaces and nothing else, so that site is what
  `FRUITBACK_CLIENTS` was. Sites, sessions and accounts are in that database, and all of it dies
  with the process: `node --watch` starts an empty one at each edit of the worker.
- **`FRUITBACK_DEV_DATABASE=pglite` is the switch, and production refuses it.** The fixture sets it;
  `readConfig` then takes the database of the process in place of `FRUITBACK_DATABASE_URL`. Under
  `NODE_ENV=production` the worker answers `503` on `/health` and names the variable, as for
  `FRUITBACK_STORE=memory`, and the job `docker image` starts the image with it to see that
  ([image.md](image.md)). The image holds neither the fixture nor PGlite. A process that has the
  switch and was not started by the fixture opens no connection: its address is a host of
  `.invalid`, and the first call says to start `pnpm dev`.
- **The notes of the dev loop stay on `linear-memory.ts`** (`FRUITBACK_STORE=memory`, the default of
  the fixture), so the whole loop — capture, issue, pins coloured by state — runs with no API key
  and writes to nobody's workspace. That store gives a new note the next state of a workflow, a
  reply on every third one and a link: what a site with a Linear connector shows, and what the
  store of the database does not (its notes have one stage, no reply and no link). Eight specs of
  the widget read those (measured: with the notes in the database, 173 specs pass and those 8
  fail). `FRUITBACK_STORE=postgres pnpm dev` keeps the notes in the database instead. `/health`
  answers `{ ok: true, store: 'memory' }`. It is
  **not** a mock: an issue is stored as the description `buildIssueDescription` produces and read
  back through the same `toSeedIssue` as production, so a broken round trip breaks the playground
  too. `FRUITBACK_FAKE_LINEAR=1` is the older spelling of that store: see _Which store, and who
  validates it_ ([worker.md](worker.md)).
- **`POST /__dev/pair` answers a pairing code for the workspace**, with its link. The `pair`
  command is another process, and cannot write in a database that lives in the worker. The route is
  in the fixture, not in the worker. **The fixture listens on `127.0.0.1`** unless `HOST` says
  otherwise: that route gives a session to whoever can reach it (raised in review). `FRUITBACK_DEV_VISIBILITY=members` makes the site one that
  only a session of the workspace reads.
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

## The git hooks (FRU-172)

### The rules, in short

- **`pnpm install` points git at `.githooks/`**, through the `prepare` script of the root:
  `core.hooksPath` is `.githooks`. There is nothing else to do, and no dependency: two shell scripts.
  - **`pre-commit` checks the format and the lint of the staged files**, with `oxfmt --check` and
    `oxlint`. It changes no file.
  - **`pre-push` typechecks and tests the packages that the branch changes**, against `main` of the
    remote, with `nx affected`. A file that no package owns runs the tests of the worker too: its
    guard tests read the documents, the workflows and the specs.
- **`pre-push` runs two test files at a time.** It sets `FRUITBACK_TEST_CONCURRENCY` to 2 when the
  variable is not already set. The `test` script of each package passes it to `node --test` as
  `--test-concurrency`, before the files. CI does not set it, so there `node --test` uses every core
  but one. `githooks.test.ts` fails on a package that does not pass it, and on a workflow that
  sets it.
- **`pre-push` starts Nx, and so every test, without the variables of git that name a repository.**
  Git gives a hook `GIT_DIR`. With it, a `git` that a test starts in a temporary directory works on
  the repository that pushes. `githooks.test.ts` runs the function of the hook that removes them.
- **CI is the gate. A hook only says it sooner.** `--no-verify` skips either one.
- **The path is relative, so a worktree runs the hooks of its own branch.** The setting is in the
  configuration of the clone, which every worktree shares: one install sets it for all of them. A
  branch that holds no `.githooks/` runs no hook. A worktree needs its own `pnpm install`: without
  it the hook says so and stops.
- **The `prepare` script passes where the repository is not.** pnpm runs it with a `--filter` too,
  and the three Dockerfiles install from the manifests alone. So the script runs the installer only
  when the file is there, and `githooks.test.ts` runs it in an empty directory.
- **pnpm does not run `prepare` when it has nothing to install.** A clone that was already up to
  date gets its hooks at its next install that installs something, or from `pnpm prepare`.
- **A hook that is not executable does not run.** Git prints a hint and the commit passes.
  `githooks.test.ts` fails on it.
- **A test starts `git` through `git.fixture.ts`, which removes the variables `GIT_*` first.**
  `pre-push` runs the tests with `GIT_DIR` set to the worktree that pushes, and a `git` started in a
  temporary directory works on that repository. `git-fixture.test.ts` plants the `GIT_DIR` of a
  hook, and fails on another file that starts git.

### The reasons, and the history

- **Two scripts, and no manager of hooks.** A manager is a dependency whose work here is one
  `git config`. This repository takes a dependency when it has measured that it needs one.
- **What each hook stops was planted, in a clone made for it** (2026-10-11). `pre-commit` refused
  an unformatted file of a package, one whose name holds a space, an unformatted table of a
  document, a nested ternary, and a global `fetch` in `packages/widget/src`, which is a rule
  `.oxlintrc.json` gives to one directory. It let pass a clean file, a deletion alone, a file of
  `design/`, and a clean staged file beside an unformatted one that was not staged. `pre-push`
  refused a type error in a test of the worker, a failing test of `packages/shared`, and a
  `CLAUDE.md` past its budget. `--no-verify` passed the same commits.
- **The times, on a machine of 10 cores at a load average of 14.** `pre-commit`: 0.2 to 0.4 s.
  `pre-push`: 8 s for a branch that changes one application, 22 s for one that changes
  `packages/shared` and so every package, both with an empty cache of Nx; 1.5 s for the same tree
  a second time.
- **`node .githooks/install.mjs` as the `prepare` script failed every image build** (measured in a
  directory that holds what a Dockerfile copies: `Cannot find module`, exit 1, for each of the three
  filters). The `docker image` job would have said so after the push. The script now looks for the
  file first. An installer that throws still fails the install: only its absence passes.
- **« Already up to date » runs no script** (measured on pnpm 11.16.0, with a `prepare` and a
  `postinstall` added to the root). A fresh clone and a fresh worktree run it.
- **`pre-push` compares with `main` of the remote, not with the last push.** A push that skipped
  the hook must not hide its commits from the next one. Nx replays what did not change, so the
  comparison costs nothing on a second push.
- **Both hooks read the working tree.** `pre-commit` checks a file staged in part as a whole.
  `pre-push` checks a ref only when it is the commit that is checked out, and says so for another
  one. What is not committed is part of what it checks.
- **The bounds on `pre-push`**: two typechecks at a time, one package of tests at a time, two test
  files at a time, and no daemon of Nx. Without the last one, `node --test` ran the files of a
  package on every core but one, on a machine that ten sessions share. `NODE_OPTIONS` refuses
  `--test-concurrency` (measured), so the variable goes through the script of each package. Node
  ignores the option after the files: four files of 300 ms took 0.43 s with `--test-concurrency=1`
  after them, and 1.58 s with it before them (measured on Node 25.8.1).
- **What the bound of two costs, and what it frees** (2026-10-11, 10 cores, load average 9 to 18,
  nothing replayed from the cache of Nx). The tests of the worker, 1,096 of them: 9 processes at
  once and 23 to 26 s without the bound, 2 processes and 28 to 29 s with it, for 81 to 87 s of
  processor against 69 s. The whole hook for a branch that changes every package, typechecks
  included: 55 s with nine files at a time, 71 s with two, for 202 s of processor against 171 s.
- **A test under `pre-push` saw `GIT_DIR`, and one changed the clone with it** (2026-10-11). Its
  `git init`, in a temporary directory, re-initialised the repository that pushed, and git wrote
  `core.bare = true` to the configuration that the clone and its worktrees share. Measured after
  the change, with a test planted to write what it sees: under a hook that is given `GIT_DIR`, the
  test reads none. Nx finds the repository from the directory it runs in, as it does outside a
  hook. A repository whose directory is given by hand, with `--git-dir`, is not found that way:
  push it with `--no-verify`.
- **The installer leaves another `core.hooksPath` as it is**, and says where the hooks are.
- **In a French shell, `pre-push` stopped a branch that changes the widget** until its four tests
  stopped reading the locale (see [conventions.md](conventions.md)).
- **A test under `pre-push` changed the clone that ran it** (2026-10-11, a commit of #148 that was
  not pushed). Its `git init`, in a temporary directory, re-initialised the repository of `GIT_DIR`.
  Git guessed that repository bare, because its path does not end in `/.git`, and wrote
  `core.bare = true` to the configuration that the clone and its worktrees share: `git status` failed
  in the clone. The two commits of the test went on the branch being pushed. A worktree reads
  `core.bare` as false and went on. Reproduced in a clone made for it, then held by a test. The
  scan of `git-fixture.test.ts` reads the text: it sees a direct call, and not a name held in a
  variable, nor a script that a test starts.

## The E2E suite

### The rules, in short

`pnpm e2e` (Playwright, `e2e/`) starts both servers itself and runs its specs against Chromium. It
builds `dist` first, because `package.spec.ts` loads the real file.

- **Assert on what you measured, never on a second measurement.** Poll until a value satisfies the
  check and keep _that_ value: a computed colour read mid-transition is the interpolated one (which
  Chromium serializes in another colour space), and the composer clears its confirmation 1.1s after
  showing it. Synchronise on the planted identifier (`sendNote`, `plantPin` of `e2e/pin.ts`), not on
  a pin count and not on the status line. The old pins are still in the DOM while the new set is
  being fetched, so counting races. The status line has two writers, and the widget's « 1 pin »
  can land after « planté · … »: 4 runs out of 80 of `attribution.spec.ts` under load (FRU-186).
- **Each run of a spec has a page of its own**, a retry and each `--repeat-each` repetition
  included (`caseOf` of `e2e/pin.ts`). The worker's store lives for the whole run. A flaky spec is
  measured with `--repeat-each 20 --workers 1`.
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
- **Each worker of the suite is the worker of development** (`dev-worker.fixture.ts`, FRU-223): a
  database in its process, one workspace, the site `playground`. No spec reads `FRUITBACK_CLIENTS`
  or a session file. A spec mints its pairing code with `mintPairing` of `e2e/extension.ts`, which
  asks `POST /__dev/pair` of the worker that will take the code; the `pair` command has its tests in
  `cli.test.ts`, and the job `docker image` runs it in the image. The suite never reuses a worker
  already on its port. Stop `pnpm dev` before `pnpm e2e`.
- **The team spec pairs with a second worker on `8789`, whose site is read by members only**
  (`FRUITBACK_DEV_VISIBILITY=members`): on a site that everyone reads, a pin read back proves
  nothing about the relay, because the page could read it with no credential. **Its notes are in
  its database** (`FRUITBACK_STORE=postgres`), so the suite writes and reads a note through the
  store of the database in a browser; the first worker keeps the Linear in memory, for the specs
  of the widget.

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

### On PostgreSQL: what is prepared, and what is not decided (FRU-223)

PostgreSQL becomes required (FRU-184), and the demonstration has no database and no secret, by the
choice written above. **What it becomes is a decision of Mathieu that is not taken**: a database
beside it that is emptied every night, the image of before kept as it is, or no demonstration.
Nothing here changes the demonstration of today, and nothing was deployed.

- **The worker of development is not an answer for it.** The demonstration runs the image, which
  refuses `FRUITBACK_DEV_DATABASE` and holds no PGlite.
- **`apps/playground/demo/postgres/` is what the first option needs from this repository.**
  `seed.sql` makes the workspace and the site `playground` that the page names: the console makes a
  site for a person who signed in, and nobody signs in there. It can run again.
  `reset.sh` takes the place of `../reset.sh`: it empties the notes, their replies and their
  pictures in the container of the database, gives the numbers back to 1, and runs `seed.sql`. The
  worker is not restarted. test:`gets its workspace and its site from seed.sql, twice with one
result, and the worker serves the site` and test:`empties tables that the schema has, and no other,
in reset.sh` hold the two files to the schema. `reset.sh` itself ran once by hand, on PostgreSQL 17
  in a container: see the pull request.
- **What that option costs, and why it is a decision.** A worker with a database refuses to start
  without `FRUITBACK_IDENTITY_SECRET` and `FRUITBACK_CONSOLE_URL`: the instance would hold a secret
  and the password of a database, where it holds nothing today, and the two sentences above (« the
  container holds nothing », « this instance must hold none ») stop being true for the worker. It
  also needs a PostgreSQL service in Dokploy, a volume or the acceptance of an empty database at
  each deployment, and the crontab of the host changed to the new script.
