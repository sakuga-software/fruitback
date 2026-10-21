# Stage names: from the orchard to plain words

FRU-355 asked to remove `seeded`, `ripening` and the other fruit words everywhere, and to use generic
terms. This page was the framing (#482). Mathieu answered its six questions on 2026-10-21: they are
_The decisions_ at the end, and the rules below follow them.

## Stage names

### The rules, in short

- **The five stages are `new`, `todo`, `progress`, `done` and `closed`** (FRU-355). One lowercase word
  each: the words of the labels of FRU-334, and the keys the console kit already used.
- **Only the names changed.** Five stages, the same order, the same meaning, the same colours.
  `stage` is still the name of the field, and `seed` the name of a note's payload (decision 2).
- **The old names are gone everywhere, at once, with no compatibility** (decisions 3 and 4). No
  reader maps an old name, the worker translates nothing, the read carries no version, and no CSS
  token keeps an alias. An old name is now what any unknown stage is.
- **The stored names were renamed by `0026_stage_names`**, an UPDATE written by hand into the empty
  file of `drizzle-kit generate --custom`. No CHECK names a stage: the check is `SEED_STAGES`, in code.
- **A migration that ran is history.** `0025_site_statuses` still says `IN ('seeded', …)`, and its
  test still plants the old names: it is what that migration read.
- **`@fruitback/shared` and `@fruitback/widget` are 0.3.0** (decision 5): a published type lost five
  values.
- **This amends one rule of [statuses.md](statuses.md):** « the five stages stay the contract,
  unchanged ». Their number, order and meaning stay; their names changed.

### What there was

Measured on `main` at 29e58161, 2026-10-21, before the rename, with `git grep -P`. A hit is one of `seeded`,
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

Each kind of hit, and whether it crosses a boundary between two programs of different versions. The
framing planned a compatibility for each crossing; decisions 3 and 4 dropped them all (below).

| What                                                                                           | Crosses a version boundary                                                | What the framing planned               |
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

The starting proposal was `new`, `todo`, `in_progress`, `done`, `closed`. The framing proposed
`progress` instead of `in_progress`, and decision 1 took it:

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
  file (`side-panel.ts`). The tab is `finished` in the code now (decision 6).

Rejected: Linear's own types (`backlog`, `unstarted`, `started`, `completed`, `canceled`). They are
one provider's words, which FRU-23 took out of the contract, and they are not the labels.

### No compatibility, on purpose

Fruitback has no users yet (2026-10-13). Decisions 3 and 4 trade the compatibility the framing
planned for one change made once. What that leaves, read from the code and not measured in a
browser:

| Who                                                       | What happens after the change                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A widget of before, cached at `/v/0.2.0-…/`               | It receives `new`, `todo`…: `var(--fruitback-stage-new)` is not one of its tokens, so its pins have no fill colour. |
| The `hiddenStages` a widget kept in `localStorage`        | `isStage` drops the old names on read: the filters of the panel come back to « everything shown ».                  |
| A host that set `theme: { 'stage-seeded': … }`            | `applyTheme` ignores an unknown token, as for any other name: the default colour shows.                             |
| An extension of before, on a worker of after              | Its counts and chips read keys that are no longer sent: they show nothing until it updates.                         |
| The console, one image, and the worker, another (FRU-222) | Released with the same tag. Between the two deploys, the counts of the sites read zero.                             |
| The read cache (`CACHE_TTL_MS`, 15 s)                     | An answer of before can be served for 15 s after the deploy.                                                        |

None of these loses a note: a pin with no colour is still drawn, and every count comes back with the
next read.

### The migration

`0026_stage_names`, after `0025_site_statuses` of #473:

- `seeds.stage`, `note_index.stage` and `statuses.stage`: an UPDATE with a CASE, only on the rows that
  hold an old name.
- `connectors.settings`, the JSON text where FRU-102 kept a stage per Linear state: only a value that
  is JSON and whose `stages` is an object is read, with CASE nested as in `0025`. Inside `stages`, a
  string that is an old name changes; every other key and value stays.
- The keys of the source `own`: its five built-in statuses are keyed by their stage (statuses.md),
  so `statuses.key` of `own` and `seeds.status_key` are renamed too. A key is renamed only when the
  site has no `own` status that holds the new name already, since a team may have added one keyed
  `done` and the primary key must hold; a note then keeps the old key, which its status still has.
- It can run twice. `stage-names-migration.test.ts` starts from a database migrated through `0025` and
  filled with old names, and proves the rename, a second run, and the rollback.

**Rollback.** The worker of before reads only old names, so a rollback of the image needs the data
back first: run `REVERSE_SQL` of `stage-names-migration.test.ts` (the same UPDATE, the other way),
then start the image of before. The test runs that SQL. One value does not round-trip: a Linear
exception that was already `done` in `connectors.settings` comes back `ripe`, which names the same
stage.

### The PRs

| PR            | What                                                                                                           | Critical |
| ------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| #482          | The framing.                                                                                                   | No       |
| The rename    | Contract, migration, worker, widget, extension, console, their tests and specs, and this page, in one PR.      | **Yes**  |
| The documents | The other pages of `docs/`, `design/`, the Markdown at the root and the issue template. Stacked on the rename. | No       |

One PR for the code, because the contract cannot change without its readers: `SeedStage` is a type,
so a contract renamed alone fails the typecheck of every package that reads it, and `main` would be
red until the last of them merged.

### The decisions

Mathieu, 2026-10-21, in a comment on FRU-355. Each answers a question of #482; the recommendation of
the framing follows in brackets when the answer differs from it.

1. **`progress`**, not `in_progress`.
2. **`seed` is not renamed here.** A ticket of its own, for a name that fits better.
3. **The change is made now**, while there are no users: no time when the worker translates for an
   old widget. (The framing recommended translating until a measure showed no old reader.)
4. **One change, in one release**, not a release N then N+1. (The framing recommended two releases,
   for a rollback with no SQL.)
5. **Yes**: `@fruitback/shared` and `@fruitback/widget` go to 0.3.0.
6. **Yes**: the « Done » tab of the extension is `finished` in the code; its label does not change.
