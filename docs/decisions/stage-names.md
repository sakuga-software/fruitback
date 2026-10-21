# Stage names: from the orchard to plain words

FRU-355 asks to remove `seeded`, `ripening` and the other fruit words everywhere, and to use generic
terms. This page is the framing, written before any code. Nothing here is decided until Mathieu
answers _The questions_ at the end.

## Stage names

### The rules, in short (proposed)

- **The five stages become `new`, `todo`, `progress`, `done` and `closed`.** One lowercase word
  each, the words of the labels of FRU-334, and the keys the console kit already uses.
- **Only the names change.** Five stages, the same order, the same meaning, the same colours.
  `stage` stays the name of the field, and `seed` stays the name of a note's payload (see question 2).
- **Every reader accepts both names, for good.** `normalizeStage` in `shared` maps an old name to its
  new one. It is one table of five lines, and it is what lets a widget, an extension, a console and a
  worker of different versions read each other.
- **A writer writes the old names until the switch, and the new ones after.** The switch is one
  release, never the same release that teaches the readers.
- **The read is versioned.** A new reader asks for the new names with `?contract=3`. A worker sends
  the new names only to a reader that asked, and the old names to every other one.
- **A host's old CSS token still works.** `--fruitback-stage-seeded` is an alias of
  `--fruitback-stage-new`, and `theme: { 'stage-seeded': … }` is still accepted.
- **The database is migrated in two steps, and each one rolls back without SQL.** See _The
  migration_.
- **This amends one rule of [statuses.md](statuses.md):** « the five stages stay the contract,
  unchanged ». Their number, order and meaning stay; their names change, in PR 5. That page is
  edited by FRU-365 now, so it is amended then, not here.

### What exists today

Measured on `main` at 29e58161, 2026-10-21, with `git grep -P`. A hit is one of `seeded`,
`ripening`, `ripe` or `composted` as a whole word, or `green` in a form that is a stage (quoted, a
key, a token, a message key). « green » as in « the CI is green » is not counted.

| Where                                          |   Files |    Hits |
| ---------------------------------------------- | ------: | ------: |
| `packages/shared` (the contract), code         |       2 |       9 |
| `packages/shared`, tests                       |       2 |      38 |
| `packages/widget`, code                        |       8 |      47 |
| `packages/widget`, tests                       |      11 |     155 |
| `apps/worker`, code                            |       8 |      26 |
| `apps/worker`, tests and fixtures              |      24 |     161 |
| `apps/worker/cloud/drill-seed.sql`             |       1 |       5 |
| `apps/console`, code                           |       6 |      32 |
| `apps/console`, tests                          |       2 |      12 |
| `apps/extension`, code and its three CSS files |      11 |     101 |
| `apps/extension`, tests                        |       8 |      99 |
| `e2e/`                                         |      15 |     102 |
| `docs/` and the Markdown at the root           |       8 |      90 |
| `design/`                                      |       2 |      15 |
| `.github/ISSUE_TEMPLATE/new_connector.yml`     |       1 |       4 |
| **Total**                                      | **109** | **896** |

**Nobody reads these words today.** The widget, the extension and the console already say New, To
do, In progress, Done and Closed (FRU-334), from `messages.ts`, `connector-parts.tsx` and the
extension's catalog. So FRU-355 changes identifiers, data and documents, not what a person reads.

What each kind of hit costs depends on whether it crosses a boundary between two programs that can
be of different versions:

| What                                                                                           | Crosses a version boundary                                                | Cost of a rename                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `SEED_STAGES`, `SeedStage`, `DEFAULT_SEED_STAGE` in `packages/shared/src/issue.ts`             | Yes: `@fruitback/shared` 0.2.0 is published                               | A breaking change, so 0.3.0            |
| `stage` on each issue, and `stages`, in `GET /feedback`                                        | Yes: widget ↔ worker. The widget at `/v/<version>/` is cached a year      | Versioned read (below)                 |
| `stage` in `GET /session/notes` and its `?stage=` filter                                       | Yes: extension (store updates) ↔ worker (self-hosted, any version)        | Versioned read, both names in a filter |
| `?stage=` and the counts `{ seeded, green, … }` of the console API                             | Console and worker are two images (FRU-222), deployed one after the other | Console reads both for one release     |
| `seeds.stage`, `note_index.stage` (and its index), `connectors.settings.stages`                | Yes: a worker rolled back reads what the next one wrote                   | Two-step migration                     |
| `statuses.stage`, and the keys of the five built-in statuses of the source `own` (FRU-365/367) | Same                                                                      | Same migration                         |
| `hiddenStages` in the widget's `localStorage` (`fruitback:config`)                             | Yes: written by one widget version, read by the next                      | `isStage` would drop them: normalize   |
| `--fruitback-stage-*` and `--fruitback-color-on-stage-*`, and `THEME_TOKENS`                   | Yes: a host page sets them (`theme` in [install.md](../install.md))       | Alias of the old name                  |
| The extension's copies of these tokens (`--stage-*`, `--on-stage-*`), `data-stage` attributes  | No: one build                                                             | Rename                                 |
| `stage.seeded` … in `messages.ts`, `STAGE_NAMES` and `STAGE_STATUS` in the console             | No                                                                        | Rename                                 |
| `STAGE_BY_STATE_TYPE` (Linear), `githubStage` and `GITHUB_STAGES`                              | No                                                                        | Rename                                 |
| Tests, e2e, `drill-seed.sql`, comments, docs, `design/`, the issue template                    | No                                                                        | Rename                                 |

Three facts that the plan below rests on, each measured:

- **No CHECK constraint names a stage.** `seeds.stage` (`0005`), `note_index.stage` (`0007`) and
  `statuses.stage` (FRU-365, in progress) are `text NOT NULL`. A new value needs no DDL.
- **The seed does not carry its stage.** The stage comes from the tracker on every read, never from
  the description block, so `SEED_VERSION` does not move and no Linear issue is rewritten.
- **A query parameter on `GET /feedback` costs no CORS preflight.** An anonymous read sends no
  custom header today (`embed.ts`: only `Authorization`, and only with a token). A header
  `Fruitback-Contract` would add an `OPTIONS` to every anonymous read. The answer is
  `Cache-Control: no-store`, so no cache keys on it.

### The names

| Today       | Proposed   | Label (FRU-334) | Linear types            | GitHub                           |
| ----------- | ---------- | --------------- | ----------------------- | -------------------------------- |
| `seeded`    | `new`      | New             | `triage`, `backlog`     | open                             |
| `green`     | `todo`     | To do           | `unstarted`             | —                                |
| `ripening`  | `progress` | In progress     | `started`               | —                                |
| `ripe`      | `done`     | Done            | `completed`             | closed, completed                |
| `composted` | `closed`   | Closed          | `canceled`, `duplicate` | closed, not planned or duplicate |

The starting proposal was `new`, `todo`, `in_progress`, `done`, `closed`. This page proposes
`progress` instead of `in_progress`:

- **One word goes everywhere unchanged.** A stage name is a JS key (`notes.progress`), a CSS token
  (`--fruitback-stage-progress`), a message key, an attribute value and a URL parameter.
  `in_progress` puts the only underscore into kebab-case tokens; `in-progress` cannot be a bare key.
- **The code already says it.** The console kit has `Status = 'new' | 'todo' | 'progress' | 'done' |
'closed'`, and `STAGE_STATUS` in `connector-parts.tsx` maps the stages onto it with the comment
  « the worker keeps the names of before the mockup ». The same five keys are in `sites.tsx` and
  `admin-workspaces.tsx`. The rename removes that map instead of adding a third vocabulary.
- **Against it:** `stage: "progress"` reads less well than `in_progress` in a JSON answer. That is
  question 1.

The other four are kept, with two notes:

- `closed` means « closed without being done ». At GitHub « closed » covers done too; the label
  already says Closed, and `done` is next to it, so the pair reads right.
- `done` is also the id of the « Done » tab of the extension's side panel, which holds `done` and
  `closed`. The rename makes `note.stage === 'done'` and `tab === 'done'` mean two things in one
  file (`side-panel.ts`). The tab becomes `finished` in the same PR.

Rejected: Linear's own types (`backlog`, `unstarted`, `started`, `completed`, `canceled`). They are
one provider's words, which FRU-23 took out of the contract, and they are not the labels.

### Compatibility

| Reader \ writer           | Old (writes and sends old names)                                    | New (writes new names, sends new names only when asked) |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| Old widget, old extension | today                                                               | asks nothing, so receives the old names: today          |
| New widget, new extension | asks `contract=3`, is ignored, gets the old names: `normalizeStage` | asks `contract=3`, gets the new names                   |
| New console               | reads both keys of the counts                                       | reads the new keys                                      |

- **`normalizeStage(value: unknown): SeedStage | undefined`** in `shared`, built on
  `LEGACY_STAGE_NAMES`, the table of the five old names and their new ones. `offeredStages` and
  `offeredStatuses` call it, so a list of old names is
  read as the new ones. Every reader goes through it: the widget's read and its `localStorage`, the
  extension, the console, the worker's input (`?stage=`, the console's settings, the statuses API)
  and the worker's rows.
- **Readers keep the table for good**, not for one release. It is five lines, and the widget of a
  host page that never updates its snippet is still on the old names.
- **The worker accepts the old names in input for one release after the switch**, as asked. A
  request with an old name then gets `400 invalid-stage`, like any unknown stage. The old names stay
  only in the read path above and in the translation of the answer.
- **The contract has a version.** `CONTRACT_VERSION = 3` in `shared`, sent as `?contract=3` on
  `GET /feedback` and `GET /session/notes`. The read envelope answers `contract: 3` when it used the
  new names, so a new reader knows which ones it got without guessing from the values. `3` and not
  `1`, because `SEED_VERSION` is 2 and one number per contract reads better than two that drift.
  `SEED_VERSION` itself stays at 2: the seed does not change.
- **The worker's translation of an answer is one function**, at the edge of the read
  (`legacyAnswer`), so no store, connector or route knows the old names.
- **`@fruitback/shared` and `@fruitback/widget` go to 0.3.0.** `SeedStage` loses the old names, a
  break for a TypeScript consumer; `LEGACY_STAGE_NAMES` stays exported, marked `@deprecated`.

### The CSS tokens

- The widget declares the new tokens with the old one as their fallback:
  `--fruitback-stage-new: var(--fruitback-stage-seeded, #bec2c8);`. The old token is declared
  nowhere, so it is unset unless a host sets it, and then it wins over the default.
- A host that sets the new token wins over everything. A host that sets both gets the new one.
- `THEME_TOKENS` keeps `stage-seeded` … and `color-on-stage-seeded` …, and `applyTheme` writes an old
  name under its new one. `missingStageTokens` checks the new names.
- The extension and the console keep copies of the tokens: they take the new names only, since no
  host sets them. `design-tokens.test.ts` compares the new names.
- [install.md](../install.md) lists the new names and says the old ones still work.
- **Not measured yet.** That the fallback resolves a token set by `applyTheme` and one inherited
  from the host page is how custom properties are specified, not something run here. PR 3 proves
  both in a browser before it says so.
- Removing the aliases is a later, separate decision, measured: a worker can count the reads that do
  not send `contract=3`.

### The migration

Two releases. Each one rolls back to the one before it with no SQL, because the one before it reads
everything the one after it writes.

1. **Release N, expand.** The readers learn both names (`normalizeStage`, the `contract=3` read,
   the CSS aliases). The worker still **writes** the old names, and its queries on a stage match both
   (`stage = ANY($1)`, the old and the new name): the rows of a release N+1 rolled back are new. No
   migration.
   - Roll back to N-1: nothing to do. The database holds only old names.
2. **Release N+1, switch.** The worker writes the new names, and migration `00xx_stage_names` rewrites
   the rows in one transaction:
   - `UPDATE seeds SET stage = CASE stage WHEN 'seeded' THEN 'new' … END WHERE stage IN (…)`, the same
     on `note_index` and `statuses`;
   - the values of `connectors.settings -> 'stages'` (kept one release by FRU-365);
   - the keys of the built-in statuses of the source `own`, in `statuses.key` and `seeds.status_key`.

   It adds no column and drops nothing. It is idempotent: a row already new is not touched.
   - Roll back to N: redeploy N. N reads the new names. **No SQL.**
   - Roll back to N-1 (two steps, never planned): run the reverse `UPDATE`, which is written in this
     page's PR for N+1 and run in its migration test, then redeploy N-1.

3. **Release N+2, contract.** The worker stops accepting the old names in its input, and its queries
   match only the new name. The readers keep `normalizeStage`.

Fruitback has no users yet (2026-10-13), so N and N+1 may ship a day apart. They stay two releases:
a self-hosted worker and a widget on a host page do not upgrade together.

The `IN ('seeded', …)` of `0024_site_statuses.sql` (FRU-365) is history: a migration that ran is
never edited.

### The order of the PRs

| #   | What                                                                                                                                                                                   | Critical | Why                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------- |
| 0   | This page.                                                                                                                                                                             | No       | Documentation                            |
| —   | **FRU-365 merges first** (fru-statuses). It adds `statuses.stage` and the source `own`.                                                                                                | —        | —                                        |
| 1   | `shared`: `CONTRACT_VERSION`, `normalizeStage`, `LEGACY_STAGE_NAMES`; `offeredStages` and `offeredStatuses` read both. `SEED_STAGES` unchanged.                                        | **Yes**  | Public contract                          |
| 2   | Worker, release N: `normalizeStage` on every input and every row; queries on both names; `?contract=3` and `legacyAnswer` on `/feedback` and `/session/notes`. Still writes old names. | **Yes**  | Read path of every client, rollback base |
| 3   | Widget: CSS aliases, `applyTheme` on old names, `?contract=3`, `hiddenStages` normalized. `/tfp`: a host that sets `--fruitback-stage-seeded` still colours its pins.                  | **Yes**  | A host's tokens and a reader's filters   |
| 4   | Extension and console read both names, take the new tokens, send `contract=3`. `/tfp`.                                                                                                 | No       | Display, behind 2                        |
| —   | **Release N.**                                                                                                                                                                         | —        | —                                        |
| 5   | `shared` 0.3.0: `SEED_STAGES` takes the new names. Worker, release N+1: writes them, the migration, the reverse SQL in its test, `STAGE_BY_STATE_TYPE`, GitHub.                        | **Yes**  | Data migration, public contract          |
| 6   | Names that cross nothing: message keys, `STAGE_STATUS` removed, `data-stage`, tests, e2e, `drill-seed.sql`, docs, `design/`, the issue template, comments (« how ripe a pin looks »).  | No       | Text, no boundary                        |
| —   | **Release N+1.** Then, one release later, PR 7: the worker refuses old names in input (N+2).                                                                                           | **Yes**  | Narrows an input                         |

PR 6 is the biggest (about 700 of the 896 hits) and the least risky. It can be cut by package.
A guard test lands with it: no stage word outside `LEGACY_STAGE_NAMES`, its tests and the migrations,
proved on a planted `'ripe'`.

### The questions

1. **`progress` or `in_progress`?** _Recommendation: `progress`._ One word in every syntax, and the
   console kit already uses it.
2. **Does « etc. » include `seed`?** `seed` is the payload of a note: `SeedIssue`, `SEED_VERSION`,
   the `seeds` table, the description block of every Linear issue, about 4,800 hits in 284 files.
   _Recommendation: no, not in FRU-355._ It is the name of a data structure, not a status, and
   renaming it touches the issues already written at the trackers. A separate ticket if wanted.
3. **How long does the worker translate the answer for an old widget?** _Recommendation: until a
   measure says no read comes without `contract=3`_, not a fixed number of releases. The widget at
   `/v/<version>/` is cached a year, and translating costs one function.
4. **Two releases, N and N+1, even with no users?** _Recommendation: yes._ The cost is one more
   tag; the gain is a rollback with no SQL, and a self-hosted worker that can be upgraded alone.
5. **`@fruitback/shared` and `@fruitback/widget` to 0.3.0?** _Recommendation: yes_, in PR 5: a
   published type loses five values.
6. **Rename the extension's « Done » tab to `finished`** so that `done` names one thing?
   _Recommendation: yes_, in PR 6; the label « Done » does not change.
