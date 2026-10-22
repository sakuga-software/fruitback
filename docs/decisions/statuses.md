# Statuses: added, read from the tracker, and coloured

FRU-352 asks for three things: statuses a team adds, statuses read from the tracker (Linear, GitHub,
REST), and colours a team chooses. This page was the framing, written before any code (#446).
Mathieu answered its five questions on 2026-10-21: they are _The decisions_ at the end, and the rules
below follow them. Built: the contract (FRU-364), the table, its migration and the text colour (FRU-365), the API
of the console with the statuses in the read (FRU-366), the screen of the statuses of a site (FRU-371), and
the widget and the side panel of the extension that draw them (FRU-370). The rest is FRU-367 to FRU-369,
and the parts of FRU-371 that wait for them.

## Statuses

### The rules, in short

- **The five stages stay the contract.** Their names are generic since FRU-355
  ([stage-names.md](stage-names.md)). A status is always attached to one of `new`,
  `todo`, `progress`, `done` and `closed`. The stage keeps the meaning of the lifecycle: it drives
  the filters, the counts, the « looks fixed » check and the fallback. A connector never adds a stage.
- **A status is data that the team configures, never a constant in a published type.** It has a key,
  a name, a stage, a background colour and a text colour. It travels in the read envelope, next to
  `stages`, so `SEED_VERSION` does not move.
- **Every new field is optional, and every reader is tolerant.** A widget from before ignores the
  fields and draws the stage as today. A widget from after, read by a worker from before, gets no
  list and draws the stage as today.
- **A colour is `#rrggbb`, checked on write by the worker and on read by `offeredStatuses`.**
  Nothing else reaches `style.setProperty`. A text colour travels only with a background colour.
- **The text on a status reaches 4.5:1.** By default it is computed. A text colour that the team
  chooses below 4.5:1 is refused on save.
- **The name is always shown next to the colour.** A status is never said by its colour alone, as
  the stage colours already are not.
- **A status is configured per site** (decision 2). The list a site starts from is the states of the
  tracker its destination names — the connector and the team chosen for the site (FRU-123) — or the
  five built-in statuses of the worker's store for a site with no destination. The team then renames,
  recolours, re-stages or adds, for that site only.
- **The stage of an issue wins over its status.** `statusOf` gives a status only when it belongs to
  the issue's stage, so an old and a new widget never draw two stages from one answer.

### What exists today

Measured on `main` at a00f5d57, 2026-10-21.

| Where                                          | What it does                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/issue.ts`                 | `SEED_STAGES`, `DEFAULT_SEED_STAGE`, `offeredStages`. `SeedIssue` carries `stage` (a strict enum of five) and `stateName` (the word of the store, already shown by the widget).                     |
| `packages/widget/src/theme.ts`                 | One token per stage, `--fruitback-stage-*`, and three foreground tokens `--fruitback-color-on-stage-*` (FRU-334). A host may set them.                                                              |
| `packages/widget/src/overlay.ts`               | `pinColor` is `stageToken(issue.stage)`. `stateLabel` is `stateName`, or the word of the catalog for the stage.                                                                                     |
| `packages/widget/src/embed.ts`                 | Reads `GET /feedback` with a cast, not with `seedIssueSchema`: an unknown field is ignored. An unknown `stage` would draw a pin with no colour.                                                     |
| `apps/worker/src/linear.ts`                    | Reads `state { id name type }`, maps the type to a stage, and applies the exceptions by state id (FRU-102). `listLinearStates` reads `id name type position`, not `color`.                          |
| `apps/worker/src/accounts.ts`                  | `ConnectorSettings = { showComments, stages }`, in the JSON column `connectors.settings`. At most 200 exceptions, refused whole on one bad entry.                                                   |
| `apps/worker/src/console-api.ts`               | `GET /connectors/<id>/states` and `POST /connectors/<id>/settings`, `manage-workspace`, Linear only.                                                                                                |
| `apps/console/app/routes/connector-linear.tsx` | The screen of FRU-102: one row per state of the teams that sites send to, with a select of the stage.                                                                                               |
| `apps/worker/src/github.ts`                    | Three stages from `state` and `state_reason` (FRU-32). Labels are used only as the read filter.                                                                                                     |
| `apps/worker/src/rest-connector.ts`            | **Sends only.** The notes stay in the worker, and the body of the receiver's answer is not read (FRU-122). A REST site is read from the worker's own store.                                         |
| `apps/worker/src/seeds-postgres.ts`            | The worker's own store: a `stage` column. **No route changes it**, except the « not fixed » verdict, which sets it back to `new`.                                                                   |
| `apps/extension/src/site-notes.ts`             | The extension draws statuses itself, from copies of the stage tokens that `design-tokens.test.ts` compares with `theme.ts`. Its `PanelNote` carries no `stateName`: it always shows the stage word. |

So half of the ticket is already there: Linear states are read, named, and re-attached to a stage
by the team. What is missing is the colour, a status of the worker's own store, and a way for a REST
receiver to say anything at all.

### The data model

One table, `statuses`, in the worker's PostgreSQL:

| Column       | Type                   | Meaning                                                                                                                                                  |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_id`    | text, not null         | The site. Cascade on delete, like `site_destinations`.                                                                                                   |
| `source`     | text, not null         | Where the state comes from: the id of the connector of a destination, or `own` for the worker's store.                                                   |
| `key`        | text, not null         | The id of the state at the tracker (Linear state id), a fixed key (GitHub), or a slug (own store, REST).                                                 |
| `name`       | text, null             | The name the team gives. `null` keeps the tracker's name, or the catalog word of the stage.                                                              |
| `stage`      | text, not null         | One of the five.                                                                                                                                         |
| `color`      | text, null             | `#rrggbb`. `null` is the stage colour of FRU-334, so a host override of `--fruitback-stage-*` still applies.                                             |
| `text_color` | text, null             | `#rrggbb`. `null` is computed (see the colours below).                                                                                                   |
| `position`   | integer, not null      | The order on the board.                                                                                                                                  |
| `origin`     | `tracker` or `team`    | `tracker`: a state of the provider, or a built-in status; removing its row gives back what the tracker or the worker says. `team`: added in the console. |
| `hidden`     | boolean, default false | Not offered as a choice in the console or the extension. The read still names it (FRU-366).                                                              |

The primary key is `(site_id, source, key)`. An entry exists only when the team changed something
or added a status: a tracker state with no row takes the tracker's name, the stage of its type and
the stage colour, exactly as today. At most `MAX_STATUSES` (200) per site, which is also what a
reader keeps of one read.

Per site, as decided: two sites that send to the same Linear team can show « In Review » in two
colours. A site's list is computed from its destinations (`site_destinations`, FRU-123): when a
destination changes connector or team, the rows of the old `source` stay, unused, so going back
restores them. A table rather than a bigger `connectors.settings` JSON, because the settings are per
site now, and because a status of the own store is referenced by notes (`seeds.status_key`).

### The contract

Two optional fields, both in the read envelope. Built in `packages/shared/src/issue.ts` (FRU-364):

```ts
// GET /feedback, next to `stages`: read with offeredStatuses(body.statuses)
statuses?: SeedStatus[];   // seedStatusSchema
type SeedStatus = {
  key: string;             // 1 to 200 characters, unique in this answer: `<source>:<key>`
  name: string;            // what the team or the tracker calls it; empty means the catalog word
  stage: SeedStage;
  color?: string;          // STATUS_COLOR, #rrggbb; absent means the token of the stage
  textColor?: string;      // STATUS_COLOR; only with `color`
};

// on each SeedIssue (seedIssueSchema)
status?: string;           // a key of `statuses`; statusOf(issue, statuses) resolves it
```

- **The key is qualified by its source.** A site read in several places (FRU-201) gets the statuses
  of each, and two Linear workspaces can each have a state named « In Review ».
- **`stage` stays required on every issue.** An old widget reads nothing else, and a new widget falls
  back to it when `status` is absent or names no entry of the list.
- **`stateName` stays.** An old widget shows it; the worker fills it with the name of the status.
- **`offeredStatuses(value)` in `shared`**, tolerant like `offeredStages`, and it never throws:
  - a value that is not an array is no list, and every pin keeps its stage colour;
  - an entry with no key, with a stage outside the five, or with a key already seen is dropped: the
    first wins;
  - a colour that is not `#rrggbb` is dropped from its entry, which then takes the stage colour;
  - a text colour with no background colour is dropped: its contrast was measured on a background
    the entry no longer has;
  - the first `MAX_STATUSES` valid statuses are kept: a dropped entry does not count.
- **`statusOf(issue, statuses)`** gives the status of an issue, or `undefined` to draw its stage:
  when `status` is absent, names no entry, or names an entry of another stage.
- **`status` on an issue is strict** (1 to 200 characters), like `url`. Only the worker parses an
  issue with `seedIssueSchema`, and it parses the ones it builds. The widget reads the answer with a
  cast, so the tolerance it needs is in the two readers above.
- **`SEED_VERSION` stays at 2.** Nothing changes in the seed or in the description block, so the
  round trip is untouched.

**This amends one rule of [contract.md](contract.md):** « the contract holds no colour » (FRU-24).
That rule was written against a colour **fixed in a published type**, which nobody downstream could
change. A colour that a team typed in its console and that the worker sends with the read is data,
like `stateName`. The schema holds the field, never a value. Decision 1 took it, and FRU-364
rewrote the rule in [contract.md](contract.md) to « no fixed colour in the contract ».

| Widget \ worker | Before                         | After                                                                               |
| --------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| Before          | today                          | ignores `statuses` and `status`; draws `stage`, shows `stateName` (the status name) |
| After           | no `statuses`: draws the stage | draws the status colour and text colour; filters stay by stage                      |

The widget script served at `/v/<version>/` is immutable and cached a year, so old widgets stay on
host pages for a long time: the first row is not hypothetical. `embed-statuses.test.ts` holds it:
the widget of today, which reads neither field, draws a read that carries them exactly as one that
does not — the same Shadow root markup, the same `pageNotes()`, with a control that the pins are drawn.

### Reading each provider

**Linear** (SDL of `@linear/sdk`, `WorkflowState`):

- `id`, `name`, `type` (a `String`, documented as `triage`, `backlog`, `unstarted`, `started`,
  `completed`, `canceled`, `duplicate`), `color` (« the state's UI color as a HEX string »),
  `position` (ascending within the type group), `archivedAt`. The `read` scope is enough.
- Add `color` to `STATES_QUERY` and to the `state { … }` of the issue read: no extra request.
- **No webhook reports a change of a workflow state.** A state added at Linear appears in the
  console the next time its page opens, and on a pin as soon as an issue is in it: an unknown id
  takes the stage of its type and the stage colour, as today. Nothing is cached that could go stale
  except the team's own rows.
- Stage by type, as `STAGE_BY_STATE_TYPE` does now; the site's row overrides it (FRU-102 did it
  per connector).
- Colour: the stage colour of FRU-334 by default (decision 3). A switch per site, « Use Linear's
  colours », off by default, takes `state.color` for every state with no colour of the team
  (FRU-368).

**GitHub** (REST issues, API 2022-11-28):

- **GitHub is a connector of a workspace since FRU-359 and FRU-360** (`CONNECTOR_KINDS` holds
  `linear`, `rest` and `github`), and it can still be the store of a whole worker
  (`FRUITBACK_STORE=github`). A site that sends to a GitHub connector has rows with that connector
  as their source, like Linear; a worker whose own store is GitHub has rows with the source `own`.
  Either way its statuses screen shows these four instead of the five built-in ones, with no « Add a
  status ». The copy of `0025_site_statuses` takes Linear connectors only: FRU-102 set exceptions on
  no other kind.
- Four fixed keys: `open`, `closed:completed`, `closed:not_planned`, `closed:duplicate`. A close with
  no reason is `closed:completed`, as today. `reopened` is an open issue. Stages as FRU-32:
  `new`, `done`, `closed`, `closed`. The team can rename, recolour and re-stage them.
- **Labels are not statuses.** FRU-32 already refused them: « a label a team has to remember to apply
  is a state the connector invents ». An issue can carry several labels, and two status labels on one
  issue have no answer. Decision 4: no labels, four fixed statuses (FRU-369).
- What is honest at GitHub is the **Status field of a Project v2**: a single select, with a name and
  one of eight colour names (`GRAY` … `PURPLE`). It is GraphQL only, needs the `Organization
projects: read` permission of the GitHub App (every installation must approve the change), and the
  webhook `projects_v2_item` is an organisation event in public preview. A later ticket, on demand.
- GitHub's eight colour names need a hex table of our own to be drawn; Issue types use the same
  eight names and are not statuses.

**REST** (`docs/rest-connector.md`):

- Today a receiver cannot say anything back. The answer's body is not read, and a REST site is read
  from the worker's own store. So a REST site has the statuses of the worker's own store, which the
  team configures in the console, like a site with no destination.
- Reading a state from the receiver needs a new, inbound route: the receiver calls
  `POST /connectors/<id>/status` with `{ identifier, status }`, signed with the same HMAC secret, and
  declares its list either in the console or once with `PUT /connectors/<id>/statuses`. That is a new
  surface open to the internet, so it is a ticket of its own, critical, and only if a receiver asks.
  Decision 5: not now. No ticket exists for it.

**The worker's own store** (sites with no destination, and REST sites):

- This is where « add a status » means something. A Linear or GitHub state is added at the tracker,
  and Fruitback reads it; inventing one here would be a state the tracker does not have.
- Five built-in statuses, one per stage, with the keys `new` … `closed`: a site whose team never
  opens the screen sees exactly what it sees now.
- `seeds.status_key`, nullable. `null` is the built-in status of the note's `stage`.
- A note needs a way to change status, which does not exist today: a select in the list of notes of
  the console (`manage-feedback`), and later in the extension. Changing the status writes the stage
  of that status in the same transaction, so the index, the counts and the filters keep working.

### The console

The screen of FRU-371 is built to its board, `design/site-statuses/`, which the orchestrator
validated on 2026-10-21 with the answers below. `apps/console/app/routes/site-statuses.tsx` draws it;
`site-statuses.ts` merges the rows of the worker with the defaults, with no React, and
`e2e/console-statuses.spec.ts` holds it in a browser.

- **A page of its own**, `/w/<workspace>/sites/<site>/statuses`, from the item « Statuses » of the menu
  of a site row, for an owner or an admin (`manage-sites`). Another role gets no item, and the
  address says who sets the statuses.
- **One list per source of the site.** The worker's store, when the site has no destination or sends to
  an address (REST); a GitHub destination, with its four states. A status shows its pin and its chip as
  the widget draws them, its stage (a drop and a word), its colour, and the contrast of its text,
  in words and with a mark.
- **One status is written at a time, and there is no « Save » for the page.** The sketch of this page
  drew one; the API writes one status (`POST …/statuses`), and a page-wide « Save » would be several
  writes that can half fail. The editor opens under its row and saves that status; the order and
  « Reset » write at once. One write at a time for the whole page (FRU-123): the controls wait.
- **The order is two buttons per row**, « Move … up » and « Move … down », for a keyboard and a pointer
  alike, with no dragging. The worker orders the rows it keeps, so a default with no row gets one first,
  at its new place; then `POST …/order` writes the whole list. A live region says where the status is.
- **A text under 4.5:1 is not sent.** « Save » stays enabled: a press gives focus to the field of the
  text, which the sentence describes. The worker refuses it anyway (`text-under-contrast`). The
  preview draws the colours chosen, refused ones too, and is hidden from a screen reader, which reads
  the ratio in words.
- **« Delete » for a status the team added, « Reset » for any other that differs**, with no
  confirmation: a reset takes away a name and a colour, and moves no note. « Delete » asks twice
  (FRU-165), then sends no `moveTo`: `200` was an empty status; `409 status-in-use` gives the count, and
  the screen asks where the notes go, the built-in status of the same stage first. A count of the notes
  in the read is a later addition to the API.
- **« Stage » is « Phase » in French**, not « Étape », which is the step of the setup.
- **`hidden` is not drawn**: it changes only what the status select of a note offers, which FRU-367
  brings. The status select of the list of notes is a PR of its own, after FRU-367.
- **A Linear destination is a sentence and a link to its panel, for now.** Until FRU-368, the worker
  reads the stage of a Linear state from `connectors.settings.stages`, which the table of FRU-102 on the
  panel of Linear writes; a row of the site with a Linear source would change nothing a pin shows. So
  that table stays where it is, and FRU-368 moves it here with « Use Linear's colours ». The board
  draws that part already (frames H and N).
- **A GitHub list is written now and shows with FRU-369**, which sends `status` on a GitHub issue.
  Until then a pin of GitHub draws its stage, as `statusOf` does for any issue with no `status`.

### The API of the console, and the read (FRU-366)

Routes under `/console/workspaces/<id>/sites/<site>/statuses`, all `manage-sites`:

| Route                                      | What it does                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET …/statuses`                           | The rows of the site, by `position`, then source and key.                                                       |
| `POST …/statuses`                          | Adds a status, or changes the one of that source and key. `readSiteStatus` first; the worker sets `origin`.     |
| `POST …/statuses/order`                    | `{ order: [{ source, key }] }`: each one takes its place. One unknown, or one twice: nothing changes.           |
| `DELETE …/statuses/<source>/<key>?moveTo=` | Removes it. Its notes go to `moveTo` first; with notes and no `moveTo`: `409 status-in-use`, with their number. |

- **POST, not PUT**: the CORS of the console allows `GET`, `POST` and `DELETE` (`console-cors.ts`),
  as every other write of the console.
- **A built-in status keeps its stage** (`400 built-in-stage`): a note with no `status_key` is in the
  built-in status of its stage, so moving the status would draw that note with another stage.
- **A status the team added takes its notes with it** when it changes stage, in the same transaction:
  `statusOf` draws a note by its status only when the two agree.
- **A note that a status moves takes its new stage in the index of the notes too**, in the same
  transaction (`restageIndex`, found in the heavy review of #487). The index learns a stage from a
  read of the page (FRU-237), so a note on a page nobody opens again would keep its old stage in the
  list and the counts of the console.
- **A source is `own` or a connector the site sends to** (`400 unknown-source`).
- **`MAX_STATUSES` rows per site** (`409 too-many-statuses`), what a reader keeps of one read.
- **`moveTo` is a key of the worker's store**: a built-in status (the notes then have no
  `status_key`, and its stage) or another status the team added. A state of a tracker, or a built-in
  status, holds no note of its own: removing its row brings back what the tracker or the worker says,
  and a `moveTo` there is refused.

`GET /feedback` now carries `statuses`, asked at each request and never in the cached answer:

- **The rows of the site, then the five built-in statuses that no row changed**, always: a site of
  the environment, or a read that cannot reach the database of the accounts, gets the five only, and
  each pin keeps its stage. The failure is written in the log, never in the answer.
- **A colour with no text colour gets the one `readableTextColor` computes**, on `STATUS_INK`, the
  ink of `theme.ts`, so a widget that does not compute it still writes a text over 4.5:1.
- **A note the worker keeps says `status: own:<status_key, or its stage>`.** The notes of Linear and
  GitHub say theirs with FRU-368 and FRU-369; until then they have none, and `statusOf` draws their
  stage, as before.
- **`hidden` is not in the read.** A hidden status is one the console and the extension do not offer
  as a choice (the status of a note, FRU-367; the screen, FRU-371). The notes already in it keep its
  name and colour, which they would lose if the read left it out, and the filters of the widget are
  by stage. The contract has no field for it (FRU-364), and needs none.
- **A change shows at the next read**: the list is asked at each request, and the pages of the notes
  that a removal or a change of stage moved are invalidated in the read cache (`invalidatePages`,
  found in the balanced review of #487), so their next read asks the store.

### What the widget draws (FRU-370)

- **The widget reads `statuses` with `offeredStatuses`, at each read**, and an answer with no list, or
  one it cannot use, empties it: every pin is then drawn by its stage. `statusOf` gives the status of
  each note; a note kept for later (FRU-124) has none.
- **The pin, the drop of its thread, the mark of a detached note and the drop of its row in the list
  wear the colour of the status** (`status-paint.ts`). A status with no colour keeps the token of its
  stage, so a host that set `--fruitback-stage-*` keeps it. The text on the drop is the text colour of
  the status, or `readableTextColor` on the ink of `theme.ts`, which `status-paint.test.ts` compares.
- **The thread, the row, the detached note and the text export say the name of the status**, then the
  word of the store, then the word of the stage.
- **The filters stay by stage.** The chips of the list, the settings panel and the counts are the five
  stages; `data-fruitback-stage` stays on a pin, and `data-fruitback-status` names its status.
- **The edge of FRU-334 is on every pin, whatever its colour.** It is drawn by the rules of the pin and
  of the drop, never by a stage, so a light colour that a team chooses has it in both schemes.
  `e2e/status-colours.spec.ts` measures it.
- **`pageNotes()` gives `stateName` and `status`** to a list outside the page. The side panel of the
  extension reads them with `parsePanelNotes`, the edge between the page and the extension: a colour
  only as `#rrggbb`, a text colour only with it, a status only of the note's stage. A status keeps its
  stage there, because the bridge parses the notes and the panel parses them again. A row of the panel
  wears the colour and the name of its status (`note-status.ts`), and its tabs stay by stage.
  `e2e/side-panel.spec.ts` measures a row against its pin.

### The colours

- The defaults stay those of FRU-334, in `theme.ts`, and a host can still set `--fruitback-stage-*`.
  **A colour that the team chose in the console wins over the host's token**: it was set for this
  site's tracker on purpose, and it reaches the widget, the extension and the console alike. A status
  with no colour keeps the token, so a host override keeps working.
- WCAG 2.2: relative luminance with the 0.04045 threshold, ratio `(L1 + 0.05) / (L2 + 0.05)`.
  `contrast.test.ts` already computes both.
- **The text on a pin is small, so it needs 4.5:1** (SC 1.4.3), not the 3:1 of large text.
- **The text colour, computed.** Measure the background against the ink of the theme (`#18181b`) and
  white. Take the higher one when it reaches 4.5:1. If neither does, take the higher of black
  (`#000`) and white. Measured on every 7th value of the 16.7 million colours:
  - with ink and white alone, the worst background reaches only **4.21:1** (`#547bc2`);
  - with black and white, the worst reaches **4.58:1** (`#38860a`), so the last step always passes.
  - The rule gives the FRU-334 defaults back: ink on new (9.90), to do (12.78) and in progress
    (10.11), white on done (5.45) and closed (7.02).
  - On Linear's default colours: Done `#5e6ad2` takes white (4.70), Canceled `#95a2b3` takes ink (6.83).
- **The pin on the host page is a non-text mark** (SC 1.4.11, 3:1). No colour can reach 3:1 on
  every page a host draws, which is why `--fruitback-color-stage-edge` draws its outline. A custom
  colour keeps that edge, in the light and the dark scheme.
- The function lives in `shared` (`contrast.ts`, FRU-365): `contrastRatio`, `readableTextColor` and
  `MIN_TEXT_CONTRAST`. It is pure, and the worker (to refuse a save), the console (to show the ratio)
  and the widget (to draw) must compute the same thing. It holds the algorithm and no palette: the
  ink is an argument, and black and white are the only colours it names.
- **The last step is always black.** Where neither the ink nor white reaches 4.5:1, white is under
  4.5:1, and the better of black and white is never under 4.58:1: so black is. `contrast.test.ts`
  sweeps every 97th colour of the cube: the worst answer is 4.50007:1 (the ink on `#5385ae`), and the
  worst black 4.67:1.
- **The refusal is `readSiteStatus` of `apps/worker/src/site-statuses.ts`**: a text colour with no
  background colour, or under 4.5:1 on it, is refused, never corrected. The routes of FRU-366 call it
  on every write.

### Migration

1. **Contract first, published before anything sends the fields** (FRU-364). `statuses`, `status`,
   `offeredStatuses`, `statusOf`, and the rewritten FRU-24 rule.
2. **Database, additive** (FRU-365, `drizzle/0025_site_statuses.sql`). Create `statuses`; add
   `seeds.status_key`, nullable. The FRU-102 exceptions were per connector: copy each
   `connectors.settings.stages[stateId]` into a row `(site, connector, stateId, stage)` **for every
   site whose destination is that connector**, so each site keeps what its connector showed.
   drizzle-kit wrote every statement but that INSERT, and the header of the file says so. It keeps
   only what `readConnectorSettings` keeps (a Linear connector, an id of 1 to 64 of
   `[A-Za-z0-9_-]`, one of the five stages), and settings that are not JSON copy nothing
   (`pg_input_is_valid`, PostgreSQL 16 and later; the image and CI run 17).
   `site-statuses-migration.test.ts` starts from an empty database and holds each case; it fails
   with the INSERT taken out. The JSON field stays one release; the Linear read takes the table
   first in FRU-368, and a later migration drops the field. Nothing is rewritten in place, so a
   rollback of the worker reads the JSON it left.
3. **Worker** sends `statuses` and `status`. An old widget ignores them.
4. **Widget, extension, console** read them. Their copies of the tokens do not change.

Fruitback has no users yet (2026-10-13), so the cut-over need not wait. The order still matters for
the widgets cached on host pages and for self-hosted workers.

### Risks

- **A colour is written into a style.** `style.setProperty` cannot leave its declaration, but a value
  like `var(--x)` or `url(…)` would still be read. Hence `#rrggbb` only, checked on both ends. The line
  in [SECURITY.md](../../SECURITY.md) lands with the first code that stores a colour (FRU-366) or
  writes one into a style (FRU-370), in the same commit; FRU-364 does neither.
- **The contract grows.** Two optional fields, tolerant reads, no version bump. The danger is the
  next field: the amended FRU-24 rule must still refuse a constant in a type.
- **A Linear state changes with no webhook.** The cost is a console page that shows the old list
  until it is opened again. A pin is never wrong, because the state comes with the issue.
- **Several destinations on one site.** Keys are qualified by their source; a list for one site can
  hold twenty statuses. The filters stay on five stages so that the panel does not grow with them.
- **Per site means the same state configured twice.** Two sites on one Linear team are set apart.
  The screen can offer « Copy from another site » later; nothing in the model stops it.
- **Who changes a status in the own store.** A new write on notes: `manage-feedback`, audited like
  the other writes of the console. Two people changing one note: last write wins, as for the verdict.
- **Translations.** A status the team names is shown as typed, like `stateName` now. A built-in
  status with no name keeps the catalog word, translated.
- **The extension and the console keep copies of the tokens.** A status colour is not a token, so it
  adds nothing to `design-tokens.test.ts`; the computed text colour is shared code instead.
- **GitHub Projects** would change the permissions of the App, and every installation would have to
  approve. Hence out of the first round.

### Sub-tickets

Created by the orchestrator after the decisions, children of FRU-352.

| Ticket  | What                                                                                                                                                                         | Critical | Why                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| FRU-364 | `shared`: `statuses` and `status` in the envelope, `offeredStatuses`, `statusOf`; the FRU-24 rule in contract.md; this page.                                                 | **Yes**  | Public contract                      |
| FRU-365 | Worker: the table of statuses per site, `seeds.status_key`, the copy of the FRU-102 exceptions to every site of their connector.                                             | **Yes**  | Data migration                       |
| FRU-366 | Worker: console API to read, add, change and order the statuses of a site, with the 4.5:1 refusal and the text colour function in `shared`; the SECURITY.md line on colours. | **Yes**  | New writes, roles                    |
| FRU-367 | Worker, notes kept in Fruitback: the five built-in statuses, and the route that changes the status of a note.                                                                | **Yes**  | Writes a note, and its stage with it |
| FRU-368 | Worker, Linear: read `color`, send `statuses` and `status`, « Use Linear's colours » per site.                                                                               | No       | Read path only                       |
| FRU-369 | Worker, GitHub: the four fixed statuses, renamable and recolourable per site.                                                                                                | No       | Read path only                       |
| FRU-370 | Widget and extension draw the name and the colour of the status, with the stage as fallback; `PanelNote` carries them; SECURITY.md on what reaches a style. `/tfp`.          | No       | Display; the fallback is FRU-364's   |
| FRU-371 | Console: the board in `design/`, then the statuses screen of a site and the status select in the list of notes. `/tfp`.                                                      | No       | Display, behind FRU-366 and FRU-367  |

Order: FRU-364, then FRU-365, then FRU-366 to FRU-369 in any order, then FRU-370 and FRU-371. The
REST inbound route and the GitHub Project Status field have no ticket: decisions 5 and 4 left them out.

### The decisions

Mathieu, 2026-10-21, in a comment on FRU-352. Each answers a question of #446; the recommendation of
the framing follows in brackets when the answer differs from it.

1. **The read carries the colour and the name a team chose**, as data of the site. The FRU-24 rule
   becomes « no fixed colour in the contract ».
2. **Per site, not per connector.** The statuses depend on the destination chosen in the connector.
   (The framing recommended per connector, so that every site on one team shares one board. Per site
   lets two clients of one team look different, at the cost of setting each site.)
3. **The colours of FRU-334 by default.** The tracker's colours are an option, off by default.
4. **No GitHub labels as statuses.** Four fixed statuses.
5. **No inbound REST route for now.** A REST site uses the statuses of the worker's store.
