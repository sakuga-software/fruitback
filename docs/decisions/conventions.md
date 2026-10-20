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
  `*.test.ts`, fixtures in `*.fixture.ts`.
  - **`node --test` exits 0 on a test file its glob does not match, on a glob that matches no file,
    and on `it.skip`** (FRU-174, measured). `test-discovery.test.ts` fails on a JavaScript or
    TypeScript file named `*.test.*` or `*.spec.*` (`.ts`, `.tsx`, `.js`, `.jsx`, and their `c` and
    `m` forms) that no `test` script and no Playwright directory reads, on a `test` script that
    reads no file, and on a skip with no reason. The reason goes in the options:
    `{ skip: 'the reason' }`, never `it.skip(…)` nor `skip: true`.
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
  `layout: landing`, and `docs/_layouts/landing.html` draws the board « Landing » of the mock-up
  of 2026-10-20 around it (FRU-309): the hero and the issue a note becomes, the five statuses, the
  three modes, self-hosting, the extension, the two offers and « Where it stands ». `index.md`
  keeps the guides. A layout is HTML, so its links name the `.html` page through `relative_url`.
  Say only what exists, and what `docs/` already says: a price the beta has not set is « Free during
  the beta », and the state of the images, the widget and the extension is the one of
  `self-hosting.md`, `install.md` and `reviewing.md`. The board said « no account anywhere » and « notes in
  SQLite »: neither is true now.
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
  **CI runs the `test` target twice, the second time under `fr_FR.UTF-8`**, with `--skip-nx-cache`:
  the locale is no input of the target, so Nx would replay the first run. Until then four tests of
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

- **StrykerJS mutates the seed contract and the core of the worker** (FRU-172), with its `tap`
  runner, which drives `node --test`. The scope is the `mutate` list of `packages/shared/stryker.config.json`
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
  by hand (`workflow_dispatch`), and on a pull request that changes how mutation runs: the workflow,
  a `stryker.config.json`, or `tools/mutation/`.
- **StrykerJS is installed apart**, from `tools/mutation/pnpm-lock.yaml`, by the mutation job alone.
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
- **The dry run of the worker has 15 minutes, not the 5 of StrykerJS** (`dryRunTimeoutMinutes`).
  The dry run is the whole suite of the worker, one file at a time, with coverage. Measured in CI:
  84 files in 3 minutes 51 seconds on 2026-10-14 at 09:56 (run 38545506665); the same day at 21:44
  and at 22:55 (runs 38642556303 and 38650887857) the suite had grown, and the dry run stopped at 5
  minutes, « Initial test run timed out! », with no mutant run. 15 leaves room for the suite to grow.
- **The job has 150 minutes, not 60** (`timeout-minutes`). The full run of the worker, on a pull
  request that changes how mutation runs, mutated 879 mutants in 8 files on 2026-10-14 (run
  38653521349): its dry run took 4 minutes 47, and the job was cancelled at 60 minutes, before the
  report. The weekly full run of both packages took 18 minutes on 2026-10-12. The suite became slower
  in two days, and why is not measured yet.
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
- **The run of a package uses the tests of that package only.** A survivor of `packages/shared` may be
  killed by a test of the worker or of the widget. The contract is tested where it is written, so the
  survivor is still a hole there.
