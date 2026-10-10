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
  - **The root is an Nx project too, named `workspace`, with `format` and `format:fix` only**
    (FRU-55). It formats what no package owns: `e2e/`, `docs/`, the root Markdown and JSON.
    `.oxfmtignore` gives `apps/` and `packages/` back to their own targets, and only this target
    reads it. Do not move that list to `ignorePatterns` in `.oxfmtrc.json`: every package reads that
    file, and its `oxfmt --check .` then finds no file at all.
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
- **`docs/` is a site as well as a folder** (FRU-80). GitHub Pages publishes it from `main`, and
  `docs/index.md` is its home page. **A link goes to the `.md` file, never to the page it becomes**:
  `jekyll-relative-links` rewrites it, which is what lets one file read the same on GitHub and on the
  site. `docs/_config.yml` excludes `decisions/`, which is written for whoever works on this
  repository. `docs-site.test.ts` fails on a guide the home page links from nowhere and on a link
  that names no file. The markdown stays the source: every other guard reads the files.
  **Its home page is the landing of `fruitback.com`** (`docs/CNAME`): `docs/index.md` takes
  `layout: landing`, and `docs/_layouts/landing.html` draws the hero and the two offers of
  `design/boards/3-offers.png` around it. A layout is HTML, so its links name the `.html` page
  through `relative_url`. Say only what exists: a price the beta has not set is « Free during the
  beta ».
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
- **Run the tests with `LC_ALL=en_US.UTF-8` when the shell has another locale.** Four tests of
  `packages/widget` fail under `fr_FR.UTF-8` and pass under `en_US.UTF-8` and `C` (measured on
  2026-10-10, on `main` too). CI is not affected.
- The Linear MCP server is declared in `.mcp.json` at the project scope. If its tools are missing in a
  session, it needs to be approved and authorized (`/mcp` in an interactive session) — it cannot be
  authorized from a non-interactive one.
