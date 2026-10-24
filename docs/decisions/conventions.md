# Conventions, and the guards that hold them

How this repository is formatted, tested and documented, and which test holds each rule.

## Conventions

### The rules, in short

- **Do not infer the commit convention from the top of `git log`.** Three merges (#25, #26, #27) broke the pattern
  because a title was written by reading the most recent subjects, which were themselves the first
  two deviations. Twenty-four conventional merges sat underneath and went unread. The convention is
  written in `CLAUDE.md` so it is read there.
- Formatting and linting are oxfmt / oxlint (config at the root). 120 columns, single quotes,
  trailing commas.
  - **A warning of oxlint is an error** (FRU-172). `.oxlintrc.json` sets `correctness`, the category
    oxlint turns on by default, to `error`. A warning fails nothing, so nobody reads it: `main` held
    thirteen, two unused imports of `app.ts` among them. Do not set a rule to `warn`. Turn it `off`
    with its reason, or leave it an error.
  - **The root is an Nx project too, named `workspace`, with `lint`, `format`, `format:fix` and
    `typecheck`** (FRU-55, FRU-172, FRU-173). It lints and formats what no package owns: `e2e/`, `playwright.config.ts`,
    `docs/`, the root Markdown and JSON, and a directory added to the root later. Until it had a
    `lint` target, a nested ternary in `e2e/` passed `pnpm lint` (measured).
    `.oxfmtignore` gives `apps/` and `packages/` back to their own targets, and only the targets of
    the root read it. Do not move that list to `ignorePatterns` in `.oxfmtrc.json`: every package
    reads that file, and its `oxfmt --check .` then finds no file at all.
  - **`"nx": { "includedScripts": [] }` in the root `package.json` is load-bearing.** Without it,
    Nx makes every root script a target of `workspace`. A root `test` script is `nx run-many -t test`,
    so that target would start `nx run-many -t test` again.
  - **`format:fix` is never cached** (`nx.json`). It writes files and declares no outputs, so a cache
    hit on the same unformatted input replayed the log and rewrote nothing (measured).
  - **A test that reads a file outside its project declares it as an input of its `test` target**
    (FRU-71), in its own `package.json` under `nx.targets.test.inputs`. Otherwise Nx replays the
    test from its cache when only that file changed: a broken `CONTRIBUTING.md` came back with exit
    code 0 (measured). **Such a list replaces `targetDefaults.test.inputs`**, so it starts with
    `default` and `^production`, or a change to the project's own code stops invalidating the cache
    (measured on `app.ts`). `test-inputs.test.ts` resolves every literal relative path a test names
    and fails on one that no input covers. **A path read through `new URL(path, BASE)` is resolved
    against `BASE`** when the file declares it from `import.meta.url` (FRU-83): resolved against the
    test file, `'../worker/LICENSE'` read from `apps/extension/` passed as a read of the extension's
    own. A path it cannot resolve — built from a template, joined from `..` segments, or read through
    a base the file does not declare — is written out in `DYNAMIC_READS` with what it reads, and
    checked the same way; a new one fails until it is added there. CI is not affected, because it
    never restores `.nx`.
- **Tests run on `node:test` and `node:assert/strict`** — no test runner, no transpiler, no loader.
  `pnpm test` is `node --test 'src/**/*.test.ts'`; Node strips the types itself. Colocated as
  `*.test.ts`, fixtures in `*.fixture.ts`. **The worker runs on vitest** (FRU-346): « Mutation
  testing » below says why, and how.
  - **`node --test` exits 0 on a test file its glob does not match, on a glob that matches no file,
    and on `it.skip`** (FRU-174, measured). `test-discovery.test.ts` fails on a JavaScript or
    TypeScript file named `*.test.*` or `*.spec.*` (`.ts`, `.tsx`, `.js`, `.jsx`, and their `c` and
    `m` forms) that no `test` script and no Playwright directory reads, on a `test` script that
    reads no file, and on a skip with no reason. The reason goes in the options:
    `{ skip: 'the reason' }`, never `it.skip(…)` nor `skip: true`. vitest takes a boolean there, so
    the worker writes `{ skip: NO_REAL_POSTGRES !== false }`, from a constant that holds the reason.
  - `assert.equal` / `assert.deepEqual` from `node:assert/strict` are the strict variants — no need
    for `strictEqual`.
  - Partial matching is `assert.partialDeepStrictEqual`. There is no `expect.arrayContaining`; assert
    the exact array, or narrow first with `assert.ok(result.ok)` and then compare.
  - Doubles come from `node:test`'s `mock` (`mock.method(globalThis, 'fetch', …)`), restored with
    `mock.restoreAll()` in an `afterEach`. In the worker, `mockMethod(globalThis, 'fetch', …)` of
    `mock.fixture.ts`, restored with `vi.restoreAllMocks()`.
- **Relative imports carry the `.ts` extension.** Node's ESM resolver requires it, and that is what
  lets `node --test` and `node --watch src/main.ts` run the sources with no build step. `tsc` accepts
  it through `allowImportingTsExtensions`, which is why both tsconfigs set `noEmit`.
- `packages/shared` keeps `types: []` on purpose — it is bundled into a browser widget, so touching
  `process` or `Buffer` must fail to compile. Its tests need Node types, so they typecheck through a
  separate `tsconfig.test.json`; do not "fix" this by adding `node` to the main config.
- **Every `.ts` file is read by one `typecheck` target** (FRU-173). Until then no target read
  `e2e/`, `playwright.config.ts` or the `build.ts` of a package, and `e2e/` held 14 type errors.
  - `e2e/tsconfig.json` reads the specs and `playwright.config.ts`. The `typecheck` target of the
    root (`project.json`) runs it, so `pnpm typecheck` and CI do too.
  - The `tsconfig.test.json` of a package includes `*.ts`, which is its `build.ts`: the script runs
    on Node, and that configuration is the one with Node types. `packages/fruitback` has no test and
    has that file for its `build.ts` alone.
  - A new `.ts` file in a directory that no `include` names is read by nothing. Plant a type error
    in it and run `pnpm typecheck` to know.
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
- **`docs/` is a site as well as a folder** (FRU-80). GitHub Pages publishes it from `main`, and
  `docs/index.md` is its home page. **A link goes to the `.md` file, never to the page it becomes**:
  `jekyll-relative-links` rewrites it, which is what lets one file read the same on GitHub and on the
  site. `docs/_config.yml` excludes `decisions/`, which is written for whoever works on this
  repository. `docs-site.test.ts` fails on a guide the home page links from nowhere and on a link
  that names no file. The markdown stays the source: every other guard reads the files.
  **Its home page is the landing of `fruitback.com`** (`docs/CNAME`): `docs/index.md` takes
  `layout: landing`, and `docs/_layouts/landing.html` draws the mock-up « Fruitback — landing V2 »
  around it (FRU-387, after the board « Landing » of FRU-309): the hero, without and with, how it
  works and the five stages, the product, three cases, the connectors, the two offers, care and the
  questions. `index.md` keeps the guides. A layout is HTML, so its links name the `.html` page through
  `relative_url`. It needs no script: the questions are `<details>`, and the three cases sit side by
  side rather than in tabs. The glyphs are inline SVG (icons.md), the stage colours are the widget's
  `--fruitback-stage-*`, and the text wraps as in the console (widget.md, FRU-350).
  **Every other page takes the layout `docs`** (FRU-417, after the board « Fruitback Docs »), set
  for all in `_config.yml`: a header, the six sections of `docs/_data/docs.yml` in a sidebar, the
  breadcrumb, « On this page », « Previous » and « Next », and « Improve this page ». The home of the
  guides is `docs/docs.html`. The logic is in `docs/_includes/*.liquid`, a name the HTML formatter
  leaves alone: it reflowed the Liquid of a layout into lines nobody could read. An entry of
  `docs.yml` with a `#` is a part of a page, and `docs-site.test.ts` checks that each one names a
  heading of its guide, with the id GitHub Pages gives it. Keep a heading that the console or the
  extension links to (`reviewing.html#1-install-it`, `#3-pair-in-team-mode`): its id is its address.
  **A guide split in pages keeps its addresses** (FRU-427): the pages it gave go in a folder of its
  name (`self-hosting/reverse-proxy.md`), each heading keeps its text and so its id, and
  `docs/_data/moved.yml` lists each id that left the old page with its new address. The layout leaves
  an empty element with that id at the end of the old page, and `docs.js` goes on to the new one.
  Links of the worker, the console and the repository go to the new page directly. `docs-site.test.ts`
  checks both ends of `moved.yml`, and every link between two guides, heading included.
  **A guide links a file out of the site by its address on GitHub** (FRU-429): the site publishes
  `docs/` without `decisions/`, so `../SECURITY.md` answered 404 there. `docs-site.test.ts` refuses a
  relative link that leaves the published pages.
  Code blocks and tables take `tabindex="0"`, so a keyboard can scroll them (axe,
  `scrollable-region-focusable`). The one script, `docs.js`, adds « Copy » to the code blocks.
  Say only what exists, and what `docs/` already says: a price the beta has not set is « Free during
  the beta », and the state of the images, the widget and the extension is the one of
  `self-hosting.md`, `install.md` and `reviewing.md`. The board of FRU-309 said « no account
  anywhere » and « notes in SQLite »; V2 said Jira, Trello, GitLab and Notion, SQLite, one container,
  a guest link, an export of the workspace, a support plan and a REST payload of its own. None of
  those is true now, and the pull request of FRU-387 lists what was reworded.
- **[SECURITY.md](../../SECURITY.md) states the threat model, and a change to any of it lands there too.**
  Every number in it — the rate-limit default, the proxy hops, the token lifetimes — is asserted
  against the code by `security.test.ts`, so a constant that moves without the file fails the suite.
  What that test cannot check is a _property_ that changed: a new route, a new thing stored in the
  clear, a guarantee tightened or dropped. Those are a hand edit, in the same commit.
- **A document that names a test marks the citation** (FRU-62). `test:` before the backticked name,
  and `gone-test:` for a name the prose says is gone on purpose:

  ```md
  test:`the name, copied from the test exactly`
  gone-test:`the name of a test a sentence says is gone`
  ```

  `cited-tests.test.ts` reads every `it(` and `test(` name in the repository and fails on a `test:`
  citation that matches none, and on a `gone-test:` one that matches a live test. **A truncated
  citation still greps**, which is how five names drifted with nothing to see, one of them around a
  sentence the rename had disproved. The marker is what makes the check possible at all: matching
  every backticked span reports sixteen false positives on these documents. A name that holds a
  backtick is cited between double backticks, and a name may wrap across lines — both sides are
  compared with the whitespace flattened. An example inside a fenced block is not a citation.
  **The scan skips a template literal whole, through its `${…}` and through any template inside that
  substitution** (FRU-76). A scan that closed on the first backtick read the declarations of a nested
  template as code, so a citation of a test that was gone stayed green. That is the fourth shape of
  text this guard had to learn. If a fifth one appears, read the names from the tests as they run
  rather than from their source.

- **`CONTRIBUTING.md` carries the rules a person trips over on a first pull request** (FRU-27). It
  points at `CLAUDE.md` and does not repeat all of it. `contributing.test.ts` holds its `pnpm` scripts,
  ports, Node and pnpm versions, CI checks and commit types to their sources. A new convention that an
  outside contributor cannot guess belongs there too, in one sentence.
- Work is tracked in Linear on the
  [Fruitback](https://linear.app/sakuga-software/project/fruitback-ed574263d8d6) project (team Fruitback, key
  `FRU`). Reference tickets as `FRU-xxx` in commits. Every `FRU-` number in this repository was an
  `SKG-` number until 2026-10-06, when the tickets left the Sakuga-software team; Linear still
  redirects the old keys, and merged commit messages keep them.
- **A test does not read the locale of the shell** (FRU-172). Node has a `navigator` of its own, and
  it takes its language from `LC_ALL` and `LANG`: `fr-FR` in a French shell, `en-US` on a CI runner.
  A test that needs that navigator to disagree with the page gives it a language with
  `globalNavigatorSpeaks`, from `dom.fixture.ts` of the widget, and `mock.restoreAll()` takes it back.
  **CI runs again under `fr_FR.UTF-8` every test file that read the locale in the first run**
  (FRU-344). `tools/ci/locale-probe.ts`, loaded before each test file, writes the file that uses an
  API of the language with no locale given: a formatter of `Intl` used, `toLocale…`,
  `localeCompare`, `navigator.language`. `tools/ci/locale-rerun.ts` runs those files again with the
  runner of their package, and fails when the probe wrote none. PGlite reads `navigator.languages`
  and answers the same under every locale (measured), so its reads are left out; `ci-locale.test.ts`
  measures that again, plants each API, and fails on a source that reads `LANG` or `LC_…` itself.
  Running the whole suite again took half of the `test` job. Until 2026-10-10 four tests of
  `packages/widget` failed in a French shell and passed in CI (measured on 2026-10-10). Their control
  — « the global navigator must disagree, or this proves nothing » — was right to fail: with a widget
  that reads the global navigator, the tests it guards pass in a French shell without it.
- The Linear MCP server is declared in `.mcp.json` at the project scope. If its tools are missing in a
  session, it needs to be approved and authorized (`/mcp` in an interactive session) — it cannot be
  authorized from a non-interactive one.

## The checks, and where each one runs

### The rules, in short

- **`ci.yml` runs on every pull request, whatever branch it targets, and on every commit of `main`**
  (FRU-172). Its `pull_request` trigger holds no filter: no `branches`, no `paths`, no `types`.
  `workflows.test.ts` fails on one. A pull request stacked on another one is checked as the merge of
  its branch into the branch it targets.
- **A push to a pull request cancels the run of the push before it. Nothing cancels the run of a
  commit of `main`.** The concurrency group of a pull request is its ref, and the group of a push is
  its commit. A group that two merges share lets the second one cancel the first.
- **Green apart is not green together.** Two pull requests that pass alone can break `main` when both
  merge. `ci.yml` cannot stop that: only a setting of the repository can, by a branch that must be up
  to date before it merges, or by a merge queue. `ci.yml` declares `merge_group` so that a queue has a
  run to wait for. Do not remove it: a queue whose required check never reports never merges.

### The worker on vitest (FRU-346)

**In short**

- **`pnpm test` of the worker is `vitest run`**, on `apps/worker/vitest.config.ts`: `include` is
  `src/**/*.test.ts`, the pool is `forks` with `isolate`, so each test file has a process of its
  own, as under `node --test`. A PGlite instance, a variable of the environment or a double never
  passes from one file to the next. `FRUITBACK_TEST_CONCURRENCY` sets `maxWorkers`.
  `node:assert/strict` stays.
- **`src/vitest-setup.fixture.ts` removes `NODE_ENV=test` and `TEST`**, which vitest sets and
  `node --test` did not. Under them better-auth leaves out its check of the origin, and three cases
  of `auth-instance.test.ts` failed.
- **StrykerJS runs the worker with `@stryker-mutator/vitest-runner` and `coverageAnalysis:
  "perTest"`**: a mutant runs only the tests that reach it, in workers that stay up. `vitest.related`
  is `false`: `related` would keep only the tests that import a mutated file, and leave out a test
  that starts the worker in a process or reads a document. `mutation.test.ts` holds both.
- **vitest is 5.0.5, the same in the workspace and in `tools/mutation`.** The runner of StrykerJS
  loads vitest from `tools/mutation` while the tests import the one of the workspace.
  `mutation.test.ts` fails when the two differ. The runner 10.0.0 kills 3 of the 38 mutants of
  `cache.ts` under vitest 5.0.5, and the runner 10.1.1 kills all 38 (measured on 2026-10-24): the
  mutation job needs StrykerJS 10.1.1 or later.
- **`pnpm audit --prod` reads vitest as a production dependency of the worker.** better-auth 1.7.7
  names vitest as an optional peer, and pnpm links it once vitest is in the workspace: the job
  `dependencies` then failed on vite 8.2.1 and source-map-js 1.2.1. An override `'-'` does not cut a
  peer (measured), so the lockfile moved both to their fixed versions, 8.3.4 and 1.2.2, inside the
  ranges that the console and the playground already declare. An advisory of vitest itself fails
  that job too.
- **The runner of StrykerJS sets `pool: 'threads'` and one worker**, and keeps `isolate`: each test
  file still starts its own instances. The whole suite passes that way (measured on 2026-10-21), and
  `pglite-isolation.test.ts` holds the pool and `isolate` of the config.

**Why, and the measurements** (2026-10-21, a Mac shared by other sessions, load 10 to 15,
Node 25.8.1, two workers)

- **Under `tap`, a mutant ran whole test files**, one process each (FRU-342, above). `cache.ts`
  with the 4 test files that kill its mutants first: 155 s and 161 s under `tap`, 53 s and 51 s under
  vitest, for the same 38 killed and the same survivors. The mutant of line 60 was a survivor in
  three runs and a timeout in one, as it already moved in CI.
- **The suite itself costs the same**: the 4 files in 4.7 to 7.5 s under `node --test`, 5.5 to
  6.4 s under vitest; the whole worker in 161 to 204 s, and 135 to 250 s, as the load moved.
- **In CI the full run of the worker gains less than on one file** (#450, run 39587729249, against
  the full run of `main` under `tap`, run 39565743025, before FRU-347). The longest job: 32 min 30
  (`kv.ts`) against 51 min 48 (`clients.ts`). The time of the eight jobs: 189 minutes against 233.
  `clients.ts` and `identity.ts` take 29 minutes against 52 and 49, while `kv.ts`, `session.ts`,
  `rate-limit.ts`, `cors.ts` and `store-config.ts` take as long as before. The dry run is 6 minutes.
  A mutant runs only the tests that reach it, but each test file of those tests is loaded again,
  its imports and its PGlite with it, because `isolate` holds. That load is not in the net time of
  the tests, from which StrykerJS sets the timeout of a mutant: there were 95 timeouts against 48.
  Each file holds its line, and a timeout counts as killed. Without the timeouts, `kv.ts` would be
  under its line: its 19 timeouts are to be looked at before a line moves (FRU-345). With 3 runners in place of 4, the worker has 36 timeouts and `kv.ts` 7, each file above its line (FRU-345, below).
- **The same tests pass**: the 1,942 of `node --test`, compared name by name, and the guards of this
  change. `node:test` counts a skipped
  `describe` as one test and vitest each test in it, so the skipped counts differ (145 and 568), and
  each skip of one is a skip of the other.

### The reasons, and the history

- **A stacked pull request had no check at all.** `ci.yml` held `pull_request: branches: [main]`, so
  a pull request whose base was another branch started no run. Measured on #138 while its base was
  the branch of #137: its commit `61b2160` has a run of `Sakuga Review` and none of `CI`. No check and
  « checks not started » look the same on the page of a pull request.
- **On 2026-10-11, `main` was red for 29 minutes, and one of its commits has no verdict.** #134 and
  #137 were green alone and merged 14 seconds apart. #137 tested a field that #134 had renamed, so
  `typecheck` and `test` failed on `46a5fa7`. The run of `f812d97`, the commit of #134, was cancelled:
  the group was `ci-${{ github.ref }}` with `cancel-in-progress: true`, and both pushes had the ref
  `refs/heads/main`.
- **`cancel-in-progress: false` on a shared group is not enough.** A group holds one run in progress
  and one run pending, and a third run cancels the pending one. Measured on 2026-10-11 with three
  pushes 9 seconds apart to a branch made for it, on a workflow whose group is its ref: the first
  run went on, the second was cancelled, the third waited. So the group of a push is the commit
  itself, and no two runs share it.
- **A stacked pull request proves the trigger.** #141 targets the branch of #140 and not `main`, and
  it has a run of `CI`.

## Mutation testing

### The rules, in short

- **StrykerJS mutates the seed contract and the core of the worker** (FRU-172). The seed contract
  with its `tap` runner, which drives `node --test`; the worker with its `vitest` runner and the
  coverage of each test (FRU-346, below). The scope is the `mutate` list of `packages/shared/stryker.config.json`
  and of `apps/worker/stryker.config.json`. `mutation.test.ts` fails on a file of
  `packages/shared/src` that the list leaves out.
- **The score of a file may not go down.** `tools/mutation/baseline.json` holds the score of each
  file and of each package, measured by a full run in CI. `tools/mutation/ratchet.ts` fails a run
  when a file scores under its line, a new file under the line of its package, or a full run under
  the line of the package. A line moves up by a commit that says why: `node tools/mutation/ratchet.ts
  write <package> <mutation.json>` prints it from the report of a full run.
- **A pull request mutates the files of the scope that it changes, and those whose test it changes**
  (`src/x.test.ts` for `src/x.ts`), deleted or renamed included: a pull request that deletes a test is
  measured too. A test of another name that also kills those mutants (`app.test.ts` for `identity.ts`),
  and a fixture, are not mapped: the Monday run measures them. The diff is taken from
  `github.event.pull_request.base.sha`, on a checkout with all its history, and `mutation.test.ts`
  fails on another value: the head, for one, would mutate nothing and pass. A full run happens every Monday,
  by hand (`workflow_dispatch`), and on a pull request that changes how mutation runs: the workflow
  or `tools/mutation/` for both packages, the `stryker.config.json` of a package for that package alone.
- **Each file is mutated by a job of its own** (FRU-336). The `plan` job lists them with
  `tools/mutation/scope.ts`, with no install. Each job holds the line of its file. On a full run, the
  `line` job of a package holds the line of the package on the reports of all its jobs, and fails when
  a file that has a line was not measured. `ratchet.ts write` takes a package once for each report.
- **On a pull request, mutation reports and does not block** (Mathieu, 2026-10-21). A file or a
  package under its line is a `::warning::` and a green job, and a job that fails or runs out of time
  does not fail the run (`continue-on-error` when `github.event_name == 'pull_request'`), and warns that
  its file was not measured. The summary
  of the job still gives the score against the line. On `main`, on the schedule and by hand, a line
  that is not held fails the run. `mutation.test.ts` holds both.
- **A job of a pull request is incremental** (FRU-341). Unless its package is mutated in full, it
  starts from the newest report of its file on the base branch of the pull request, else on `main`
  (`tools/mutation/reference.ts`), and StrykerJS runs again only a mutant whose code changed, a killed
  mutant whose killing test file changed or no longer reaches it, and another mutant that a new or
  changed test file reaches. A test file counts as changed when any byte of it changed: under vitest
  StrykerJS would see only the lines of each test, and miss a helper changed above them, so the step
  takes such a file out of the report. It takes the result of every other mutant from that report, so the score
  is still that of the whole file. With no report, or one it cannot read, the job mutates the whole
  file, as before. A full run takes no report: the Monday run measures every mutant again, and its
  reports are where the pull requests of the week start. What StrykerJS does not see is a change to a
  file that is neither the mutated file nor a test file (a fixture, `app.ts`) that makes a test stop
  killing a mutant it still reaches: the Monday run measures it.
- **StrykerJS is installed apart**, from `tools/mutation/pnpm-lock.yaml`, by the mutation job alone.
- **A long job writes its durations, and warns past 60 % of its limit** (FRU-343). The dry run of
  the worker went from 1 min 07 to 9 min 29 in eight days, and no one saw it until the full run ran
  out of time. The last step of each mutation job, and of `test`, `postgres`, the parts of `e2e` and
  `docker image`, runs `tools/ci/durations.ts`: a table in the summary of the run and in the log of the step (the
  summary shows only to a signed-in reader, and no API returns it), and a `::warning::`
  past 60 % of `timeout-minutes`, or of `dryRunTimeoutMinutes` for the dry run. It never fails the
  job. The step repeats the `timeout-minutes` of its job, and `ci-durations.test.ts` holds the two
  equal.
- **Never run it on a tree you care about.** `inPlace` rewrites the source files and puts them back
  at the end. A run that is killed leaves them mutated.
- **No test reads a mutated file as text**, and the run of the worker leaves no test out.
  `security.test.ts` read the constants of `identity.ts` and `session.ts` from their source, and the
  first run stopped on it. It imports them now (FRU-179). `mutation.test.ts` fails on a test that
  reads one.

### The reasons, and the history

- **The hand-planted violation was already the practice** — 79 in the conformance suite, a table of
  mutants in [dev-loop.md](dev-loop.md) — and it proves the guards that someone thought of. A tool
  plants the ones nobody thought of.
- **The `tap` runner, because it is the one that runs `node --test`.** It reads the TAP output of
  each test file, so a test for StrykerJS is a file, and coverage is measured per file. Each file
  runs in its own process. Version 10.0.0 needs no build and no loader: Node strips the types of the
  instrumented sources as it strips the others.
- **Outside the workspace, because of its weight.** Added to the root, StrykerJS 10.0.0 and its
  runner brought 125 packages, Babel 8 among them, and 1,210 lines of `pnpm-lock.yaml` to every
  install, for one job (measured on 2026-10-11).
- **`inPlace`, because the sandbox moves the files.** In a sandbox under `.stryker-tmp/`, a test
  that reads `../../../SECURITY.md` finds nothing, and the worker has twelve such tests. The CI
  checkout is thrown away after the job.
- **`plugins` names the entry file of the runner.** The directory alone is refused by Node's
  resolver (« Directory import … is not supported »), and StrykerJS then warns about an unknown
  option `tap` and goes on with another runner.
- **The score counts a mutant that no test reaches as missed.** That is StrykerJS's own score, not
  the « covered » one: a line no test runs is the first thing this is meant to show.
- **The lines were measured, not chosen** (CI, 2026-10-11, Node 26.11.1, four runners of StrykerJS
  on `ubuntu-latest`). `packages/shared`: 74.35, from 316 mutants killed of 425, in 40 seconds, and
  the same to the mutant on a second run. The core of the worker: 82.36, from 653 killed and one
  timed out of 794, in 8 minutes 44 seconds. The lowest files are `cache.ts` (65.90), `seed.ts`
  (72.12) and `identity.ts` (73.00). The holes that matter most are tickets: FRU-175, FRU-176,
  FRU-178 and FRU-179. A file that a pull request does not change costs it nothing.
- **The job of a pull request takes 1 to 4 minutes for one file, so it reports and is not required.**
  Measured on a pull request made for it (#150): 42 seconds for `seed.ts`, and for `identity.ts`
  2 minutes 32, then 4 minutes 17 once `main` held the PostgreSQL tests of #138, installs included.
  A pull request that changes every file of the worker scope takes the full run, about 10 minutes.
  That is over the five minutes a required check may cost here. A red job says which file lost what.
- **The dry run of the worker has 30 minutes, not the 5 of StrykerJS** (`dryRunTimeoutMinutes`).
  The dry run is the whole suite of the worker, one file at a time, with coverage. Measured in CI:
  84 files in 3 minutes 51 seconds on 2026-10-14 at 09:56 (run 38545506665); the same day at 21:44
  and at 22:55 (runs 38642556303 and 38650887857) the suite had grown, and the dry run stopped at 5
  minutes, « Initial test run timed out! », with no mutant run. It was then 15, and 30 since FRU-336:
  9 minutes 29 on 2026-10-20, and each job of the matrix makes its own dry run.
- **The job has 150 minutes, not 60** (`timeout-minutes`). The full run of the worker, on a pull
  request that changes how mutation runs, mutated 879 mutants in 8 files on 2026-10-14 (run
  38653521349): its dry run took 4 minutes 47, and the job was cancelled at 60 minutes, before the
  report. The weekly full run of both packages took 18 minutes on 2026-10-12. The suite became slower
  in two days, and why is not measured yet.
- **One job a file, because one job for the worker ran out of 150 minutes** (FRU-336). Measured in
  CI, the dry run of the worker: 51 test files in 1 minute 07 on 2026-10-12 at 03:48 (run 38201186488),
  61 in 2 minutes 34 that evening, 79 in 4 minutes 30 on 10-14, 87 in 6 minutes 41 on 10-17, 91 in
  7 minutes 32 on 10-19 (run 39195470365), 103 in 9 minutes 29 on 10-20. One head varies by a minute
  and a half from one runner to the next. No commit did it alone, and no test waits on a real delay:
  the step of 10-12 is better-auth on PGlite (#188, #191: `auth-organization.test.ts` takes 10 seconds
  on its own, the slowest file), and #341 moved the last SQLite tests to PGlite on 10-17. A process
  that starts PGlite takes about 1 second before its first test (0.7 for PGlite, measured on a Mac),
  and half the test files of the worker start one. A mutant runs every test file that reaches it, and
  a route test reaches every file of the scope: on 10-20 the median mutant of `clients.ts` was
  reached by 8 files, and its static ones by 103. The full run of the worker then ran out of 150
  minutes, on `main` on 10-19 and on #418 and #427, with no report. `clients.ts` alone, its 215 mutants,
  took 60 minutes on 10-20 (run 39517181686). Leaving tests out of the run would be faster, and
  this convention refuses it. An incremental run needs a full run to start from, and none finished.
  So each file has a job, under the same 150 minutes.
- **The ratchet was planted in CI, twice** (#150). Two tests of `seed.test.ts` deleted, and no source
  file changed: the job mutated `seed.ts` because its test changed, measured 67.27 under its line of
  72.12, and failed. Before that, one test of `identity.test.ts` deleted: the job mutated
  `identity.ts`, measured the same 73.00, and passed, because other test files kill the same
  mutants. A deleted test fails the job only when it was the one that held something.
- **A timeout counts as killed, and that is the one result that can move between two runs.** One
  mutant of `identity.ts` timed out in the measured run. If it survives a later run, that file drops
  under its line by half a point, and the job says so in its summary. Look at the mutant before
  you lower a line.
  It happened on 2026-10-12, over three full runs of the worker: eight mutants are a timeout in one
  run and a survivor in another. They are the sweep of `kv.ts` (three mutants), line 118 of
  `store-config.ts`, lines 328 to 330 of `session.ts`, and line 170 of `identity.ts`. `kv.ts` scored
  83.58 then 80.59 on the same sources, and the package 91.05, 90.68 and 90.93. **A line is the
  lowest that these mutants allow**: the lines of FRU-172 are written from a full run with those
  eight counted as survivors. Do not write a line from one run that scored higher on a timeout.
  The three timeouts of `clients.ts` did not move in three runs, and count as killed.
- **3 runners of StrykerJS on the 4 vCPU of a job, not 4** (`--concurrency 3`, FRU-345). A mutant has
  a budget: 1.5 × the net time of the tests that reach it, + 5 s, + the overhead of the whole dry
  run (35 to 63 s in CI). The dry run measures that net time alone, and with 4 runners the mutants
  run 4 at a time on 4 vCPU: a mutant whose killer comes late runs out of its budget. StrykerJS then
  kills the runner and starts another, and the whole budget is spent. Those timeouts are not hangs:
  under `tap`, the same 44 mutants of `cache.ts` gave no timeout on a Mac (2 runners) nor in a
  container of 2 or 1.5 CPU, and 9 to 14 in CI.
  - **Under `tap`**, on the same sources in one run (39597957606), 4 runners against 3: timeouts
    `clients.ts` 17 to 4, `identity.ts` 8 to 3, `cache.ts` 9 to 0, `kv.ts` 2 to 1. The Mutate step
    over the dry run of the same job went from 8.5 to 9.5, 6.6 to 7.3, 5.4 to 5.7 and 5.0 to 5.0: up to
    12 % more, within the spread of one runner to the next (`cache.ts` took 22 to 50 minutes on 4
    runners for the same mutants). Six of those timeouts then survived: holes that a timeout counted
    as killed. #464 kills five with a test; the sixth, `if (hit !== undefined)` in `cache.ts`, is
    equivalent and disabled.
  - **Under vitest** (FRU-346), the full run of #454 (39616968178) against the head of #450
    (39595431272, 4 runners, before #459 and #464): timeouts of the worker 73 to 36 (`clients.ts` 12
    to 9, `identity.ts` 15 to 8, `kv.ts` 13 to 7, `cache.ts` 10 to 1, `rate-limit.ts` 9 to 5,
    `session.ts` 9 to 5, `cors.ts` 3 to 0, `store-config.ts` 2 to 1). Mutant by mutant, of the
    timeouts with 4 runners, 36 are killed with 3, none survives, 31 still time out; 4 killed ones
    time out with 3. The Mutate step over the dry run moves both ways, file by file (`clients.ts` 6.2
    to 7.5, `cache.ts` 3.5 to 2.7). The runner time went from 162 to 135 minutes, on sources that
    changed between the two runs: not a measured gain of the setting.
  - **The budget is not tuned:** a higher `timeoutFactor` or `timeoutMS` lets a late kill run longer,
    so the job is longer; a lower one counts more survivors as killed. `--test-timeout` is not set: it
    would turn a hang that waits into a failed test, killed and not timed out. A loop in the mutated
    code stays a timeout whatever the budget: StrykerJS stops it at 100 times the hits of the dry run
    (`hitLimit`).
- **The run of a package uses the tests of that package only.** A survivor of `packages/shared` may be
  killed by a test of the worker or of the widget. The contract is tested where it is written, so the
  survivor is still a hole there.

### What one mutant costs, and the cut to make next (FRU-342)

A study, measured on 2026-10-21. Nothing here is applied yet: the runner, `stryker.config.json` and
the workflow are as above, and the cut is a ticket of its own, critical because it changes the CI.

**In short**

- **Under `tap`, a mutant runs the test files that reach it, one process each, in their order, and
  stops at the first that fails.** So `testsCompleted` is the place of the killer in `coveredBy`,
  plus one, and a survivor runs all of `coveredBy`. That held for each of the 885 mutants of the full
  run of #436 (run 39549806954). `node tools/mutation-study/cost.ts <mutation.json>…` checks it, and
  replays a run with fewer test files without running StrykerJS.
- **Half the time goes to mutants that time out, and they do not hang.** A timeout waits
  1.5 × the net time of the files that reach the mutant, + 5 s, + the overhead of the whole dry run
  (39 to 61 s in CI: one process start for each of the 103 files). The dry run runs one file at a
  time, and the mutants run four at a time on four cores, so a mutant whose killer comes late in the
  order runs out of that budget before it reaches it.
- **The cut to make: for each mutated file, `tap.testFiles` holds the files that kill one of its
  mutants first, read from `killedBy` of a full run.** A killed mutant still meets its killer, so it is
  still killed. A survivor runs fewer files, so it still survives. Estimated from the run of #436: the
  longest job from 81 to about 26 minutes, and the runner time from 327 to about 88 minutes.
- **What the cut can lose is a timeout,** because no report says which file a timeout would have
  failed. Four files keep their line even if every timeout survives. `cache.ts` was measured. Three
  are not proven yet: the first CI run of the cut measures them, and the ratchet holds their lines.
- **The ticket of the cut also has to:** change the guard of `mutation.test.ts` that wants
  `src/**/*.test.ts`, which is the rule « the run of the worker leaves no test out »; keep the full
  suite for the Monday run, which writes the killers again, as `ratchet.ts write` writes the lines;
  and add `src/<file>.test.ts` to the killers of `src/<file>.ts`, so that a pull request that changes
  that test is measured by it.

**The measurements**

From the eight reports of run 39549806954 (head 80e61837, 103 test files). « Reached » is
`coveredBy`, « ran » is what the bail lets run, and « load time » is a mutant that half the test
files or more reach: a top-level constant or schema, which every file that imports the module
reaches.

| Mutated file      | Mutants | Killed / timeout / survived / no coverage | Reached, mean | Ran, mean | Load time | Killers | Job, CI   | Job after the cut, estimated |
| ----------------- | ------- | ----------------------------------------- | ------------- | --------- | --------- | ------- | --------- | ---------------------------- |
| `cache.ts`        | 44      | 26 / 14 / 4 / 0                           | 22.9          | 15.8      | 3         | 4       | 50 min 42 | 5.5 min                      |
| `clients.ts`      | 213     | 171 / 21 / 14 / 7                         | 23.6          | 7.0       | 48        | 13      | 58 min 12 | 14.9 min                     |
| `cors.ts`         | 60      | 60 / 0 / 0 / 0                            | 29.7          | 5.7       | 5         | 7       | 21 min 04 | 6.4 min                      |
| `identity.ts`     | 224     | 206 / 12 / 2 / 4                          | 24.4          | 5.2       | 1         | 9       | 81 min 15 | 25.6 min                     |
| `kv.ts`           | 74      | 64 / 2 / 7 / 1                            | 35.3          | 7.7       | 34        | 8       | 37 min 43 | 12.0 min                     |
| `rate-limit.ts`   | 72      | 62 / 3 / 5 / 2                            | 21.5          | 4.8       | 24        | 6       | 28 min 11 | 6.1 min                      |
| `session.ts`      | 111     | 107 / 3 / 1 / 0                           | 28.4          | 4.3       | 10        | 8       | 31 min 50 | 14.4 min                     |
| `store-config.ts` | 87      | 87 / 0 / 0 / 0                            | 20.7          | 1.9       | 25        | 3       | 17 min 38 | 3.5 min                      |

- **Where the time goes**, priced with the `node --test` time of each file on a Mac: timeouts 53 %,
  killed mutants 45 %, survivors 1 %. Timeouts are 76 % of `clients.ts` and 78 % of `cache.ts`. The
  same model is 1.9 to 4.9 times under the CI durations, so only its ratios are used: each job after
  the cut is its CI dry run and its CI mutant time, each scaled by the ratio of the model, plus its
  setup. A timeout is priced as a timeout after the cut too, so the estimate is high.
- **The killers.** `workspaces.test.ts` comes first in the order and kills first 89 mutants of
  `clients.ts`, 98 of `identity.ts` and 44 of `session.ts`. The unit test of each file is among the
  killers of that file. With the bail, `killedBy` names the first killer only, so a file that kills
  what no other file kills is proven only when it is the one file that reaches the mutant: 80 killed
  mutants, such as 22 of `identity.ts` by `identity.test.ts` and 28 of `rate-limit.ts` by
  `rate-limit.test.ts`. The cut does not need more: it keeps every first killer.
- **`cache.ts`, run on a Mac** (`--concurrency 2`, the same source as run 39549806954). With its 4
  killers: 2 min 17, a dry run of 4 files in 7 seconds, the 26 killed still killed, the 4 survivors
  still survivors, 12 of the 14 timeouts killed by `cache.test.ts`, and 2 survivors (lines 60 and
  70). With all 105 files and `--test-timeout=30000`: 19 min 42, and the same status for each mutant:
  the 2 run all 27 files that reach them, and all pass. So they did not hang in CI, they ran slower
  than their budget. The line of `cache.ts`, 86.36, is 38 of 44: it already counts them as survivors.
- **The score if every timeout survives**, against the line: `cors.ts` 100 (100), `store-config.ts`
  100 (100), `session.ts` 96.40 (96), `kv.ts` 86.49 (86.48), all held; `cache.ts` measured above;
  `identity.ts` 91.96 (93.5), `rate-limit.ts` 86.11 (89.39), `clients.ts` 80.28 (89.42), not proven.

**The other two ways, and why not now**

- **A runner that follows each test** (`coverageAnalysis: "perTest"` at the level of a test, which the
  config already asks for but `tap` cannot give). StrykerJS has no runner for `node --test`. The
  command runner has no coverage at all, so each mutant would run the whole suite. The vitest runner
  would mean moving 105 test files and 43,749 lines off `node:test`: `describe` and `it` in every one,
  `mock.method` 55 times in 25 files, `t.skip` in 4, `mock.timers` in 1, and 10 files that start a
  process, whose coverage a runner in one process does not see. Either the worker leaves `node --test`
  or it keeps two runners. Effort: days, and not measured. The cut above gives most of the gain first.
- **Fewer static mutants.** Under `tap` there are none: the coverage of a test is that of its whole
  process, module load included (`tap-test-runner.js`, `coverage.static` of each file becomes its
  `perTest`). So `ignoreStatic` changes nothing. The load-time mutants above are 150 of 885 and a
  third of the time, mostly through the timeouts of the schemas of `clients.ts`. Most are killed by
  the first file that runs. Making those constants lazy would change code for the tool's sake, and the
  cut already limits them to the killers.
- **Not measured:** an order of `tap.testFiles` that puts the unit test first. The runner takes the
  order of `glob`, which does not promise one. A lower `--concurrency` is measured above (FRU-345).
