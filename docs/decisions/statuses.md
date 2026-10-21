# Statuses: added, read from the tracker, and coloured

FRU-352 asks for three things: statuses a team adds, statuses read from the tracker (Linear, GitHub,
REST), and colours a team chooses. This page is the framing, written before any code. **Nothing here
is built yet.** The five questions at the end wait for Mathieu, and the sub-tickets wait for his answers.

## Statuses

### The rules, in short (proposed)

- **The five stages stay the contract, unchanged.** A status is always attached to one of `seeded`,
  `green`, `ripening`, `ripe` and `composted`. The stage keeps the meaning of the lifecycle: it drives
  the filters, the counts, the « looks fixed » check and the fallback. A connector never adds a stage.
- **A status is data that the team configures, never a constant in a published type.** It has a key,
  a name, a stage, a background colour and a text colour. It travels in the read envelope, next to
  `stages`, so `SEED_VERSION` does not move.
- **Every new field is optional, and every reader is tolerant.** A widget from before ignores the
  fields and draws the stage as today. A widget from after, read by a worker from before, gets no
  list and draws the stage as today.
- **A colour is `#rrggbb`, checked on write by the worker and on read by the widget.** Nothing else
  reaches `style.setProperty`.
- **The text on a status reaches 4.5:1.** By default it is computed. A text colour that the team
  chooses below 4.5:1 is refused on save.
- **The name is always shown next to the colour.** A status is never said by its colour alone, as
  the stage colours already are not.
- **A status is configured per connector, and the worker's own store counts as one connector per
  workspace.** The states belong to the tracker, and a site reads the states of the tracker its
  notes go to (FRU-201).

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
| `apps/worker/src/seeds-postgres.ts`            | The worker's own store: a `stage` column. **No route changes it**, except the « not fixed » verdict, which sets it back to `seeded`.                                                                |
| `apps/extension/src/site-notes.ts`             | The extension draws statuses itself, from copies of the stage tokens that `design-tokens.test.ts` compares with `theme.ts`. Its `PanelNote` carries no `stateName`: it always shows the stage word. |

So half of the ticket is already there: Linear states are read, named, and re-attached to a stage
by the team. What is missing is the colour, a status of the worker's own store, and a way for a REST
receiver to say anything at all.

### The data model

One table, `statuses`, in the worker's PostgreSQL:

| Column         | Type                   | Meaning                                                                                                      |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `workspace_id` | text, not null         | The workspace. Cascade on delete, like `connectors`.                                                         |
| `connector_id` | text, null             | The connector. `null` is the store of the worker (PostgreSQL, or GitHub) for this workspace.                 |
| `key`          | text, not null         | The id of the state at the tracker (Linear state id), a fixed key (GitHub), or a slug (own store, REST).     |
| `name`         | text, null             | The name the team gives. `null` keeps the tracker's name, or the catalog word of the stage.                  |
| `stage`        | text, not null         | One of the five.                                                                                             |
| `color`        | text, null             | `#rrggbb`. `null` is the stage colour of FRU-334, so a host override of `--fruitback-stage-*` still applies. |
| `text_color`   | text, null             | `#rrggbb`. `null` is computed (see the colours below).                                                       |
| `position`     | integer, not null      | The order on the board.                                                                                      |
| `origin`       | `tracker` or `team`    | `tracker`: read from the provider, cannot be deleted here. `team`: added in the console.                     |
| `hidden`       | boolean, default false | A tracker state the team does not want in the filters.                                                       |

The primary key is `(workspace_id, connector_id, key)`. An entry exists only when the team changed
something or added a status: a tracker state with no row takes the tracker's name, the stage of its
type and the stage colour, exactly as today. Bounded per connector, like the 200 exceptions now.

A table rather than a bigger `connectors.settings` JSON, because the worker's own store has no row in
`connectors`, and because a status of the own store is referenced by notes (`seeds.status_key`).

### The contract

Two optional fields, both in the read envelope:

```ts
// GET /feedback, next to `stages`
statuses?: {
  key: string;          // unique in this answer: `<connector>:<key>`, see below
  name: string;         // what the team or the tracker calls it; empty means the catalog word
  stage: SeedStage;
  color?: string;       // #rrggbb; absent means the token of the stage
  textColor?: string;   // #rrggbb; absent means the token of the stage
}[];

// on each SeedIssue
status?: string;        // a key of `statuses`
```

- **The key is qualified by the connector.** A site read in several places (FRU-201) gets the
  statuses of each, and two Linear workspaces can each have a state named « In Review ».
- **`stage` stays required on every issue.** An old widget reads nothing else, and a new widget falls
  back to it when `status` is absent or names no entry of the list.
- **`stateName` stays.** An old widget shows it; the worker fills it with the name of the status.
- **`offeredStatuses(value)` in `shared`**, tolerant like `offeredStages`: a value that is not an
  array is no list; an entry with a bad stage is dropped; a colour that is not `#rrggbb` is dropped
  from its entry, which then takes the stage colour. It never throws.
- **`SEED_VERSION` stays at 2.** Nothing changes in the seed or in the description block, so the
  round trip is untouched.

**This amends one rule of [contract.md](contract.md):** « the contract holds no colour » (FRU-24).
That rule was written against a colour **fixed in a published type**, which nobody downstream could
change. A colour that a team typed in its console and that the worker sends with the read is data,
like `stateName`. The schema holds the field, never a value. The rule should be rewritten to say so
in the same pull request as the contract change. This is question 1.

| Widget \ worker | Before                         | After                                                                               |
| --------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| Before          | today                          | ignores `statuses` and `status`; draws `stage`, shows `stateName` (the status name) |
| After           | no `statuses`: draws the stage | draws the status colour and text colour; filters stay by stage                      |

The widget script served at `/v/<version>/` is immutable and cached a year, so old widgets stay on
host pages for a long time: the first row is not hypothetical.

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
- Stage by type, as `STAGE_BY_STATE_TYPE` does now; the team's row overrides it (FRU-102).
- Colour: the stage colour by default. A switch per connector, « Use Linear's colours », takes
  `state.color` for every state with no colour of the team. This is question 3.

**GitHub** (REST issues, API 2022-11-28):

- **GitHub is not a connector of a workspace.** It is the store of a whole worker
  (`FRUITBACK_STORE=github`), and `CONNECTOR_KINDS` holds only `linear` and `rest`. Its statuses are
  therefore the rows with `connector_id` `null`, like the worker's own PostgreSQL store, and on a
  worker whose store is GitHub the « Fruitback statuses » screen shows these four instead of the five
  built-in ones, with no « Add a status ».
- Four fixed keys: `open`, `closed:completed`, `closed:not_planned`, `closed:duplicate`. A close with
  no reason is `closed:completed`, as today. `reopened` is an open issue. Stages as FRU-32:
  `seeded`, `ripe`, `composted`, `composted`. The team can rename, recolour and re-stage them.
- **Labels are not statuses.** FRU-32 already refused them: « a label a team has to remember to apply
  is a state the connector invents ». An issue can carry several labels, and two status labels on one
  issue have no answer. This is question 4.
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
  This is question 5.

**The worker's own store** (sites with no destination, and REST sites):

- This is where « add a status » means something. A Linear or GitHub state is added at the tracker,
  and Fruitback reads it; inventing one here would be a state the tracker does not have.
- Five built-in statuses, one per stage, with the keys `seeded` … `composted`: a workspace that never
  opens the screen sees exactly what it sees now.
- `seeds.status_key`, nullable. `null` is the built-in status of the note's `stage`.
- A note needs a way to change status, which does not exist today: a select in the list of notes of
  the console (`manage-feedback`), and later in the extension. Changing the status writes the stage
  of that status in the same transaction, so the index, the counts and the filters keep working.

### The console

One screen per connector, which replaces the table of FRU-102, and one for the worker's own store,
under the workspace settings:

```
Workspace › Connectors › Linear (acme)                                        [ Save ]
─────────────────────────────────────────────────────────────────────────────────────
Statuses
These are the states of the Linear teams your sites send to. Each one belongs to a
stage, which decides the filters and the counts.

[x] Use Linear's colours                                    (Reset to defaults)

 Preview        Name (Linear)      Name shown       Stage          Colour      Text
 ─────────────  ─────────────────  ───────────────  ─────────────  ──────────  ───────────────
 (3) Backlog    Backlog            —                New       ▾    #bec2c8 ▣   Auto   9.90:1
 (3) Todo       Todo               To do            To do     ▾    #d9dbdf ▣   Auto  12.78:1
 (3) In Review  In Review          —                In progress ▾  #f3bb3d ▣   Auto  10.11:1
 (3) Done       Done               —                Done      ▾    #5560c4 ▣   Auto   5.45:1
 (3) Canceled   Canceled           —                Closed    ▾    #a52a3a ▣   #ffaaaa  3.87:1 ✕
                                                                    Text below 4.5:1: choose Auto
                                                                    or a darker or lighter colour.
 Team: Design (two states come from this team)
 ...
```

```
Workspace › Statuses of Fruitback                                    [ Add a status ]
 Preview        Name             Stage          Colour      Text         Notes
 (3) New        New              New       ▾    default     Auto           12
 (3) Waiting    Waiting client   To do     ▾    #7dd3fc ▣   Auto  10.63:1   3   [Delete]
 ...
```

- The preview is a real pin and a real list row, drawn with the widget's styles.
- Delete a status of the team: its notes move to the built-in status of its stage, and the dialog
  says how many.
- `manage-workspace`, like FRU-102. The words go through `t`, and every new sentence has its French.
- A board in `design/` should come first: the screen is new.

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
- The function lives in `shared`: it is pure, and the worker (to refuse a save), the console (to show
  the ratio) and the widget (to draw) must compute the same thing. It holds the algorithm, and the
  three candidate colours as arguments, not a palette.

### Migration

1. **Contract first, published before anything sends the fields.** `statuses`, `status`,
   `offeredStatuses`, the text colour function, and the rewritten FRU-24 rule.
2. **Database, additive.** Create `statuses`; add `seeds.status_key`, nullable. Copy every
   `connectors.settings.stages[stateId]` into a row `(workspace, connector, stateId, stage)`. Keep the
   JSON field one release and read the table first; drop it in a later migration. Nothing is
   rewritten in place, so a rollback of the worker reads the JSON it left.
3. **Worker** sends `statuses` and `status`. An old widget ignores them.
4. **Widget, extension, console** read them. Their copies of the tokens do not change.

Fruitback has no users yet (2026-10-13), so the cut-over need not wait. The order still matters for
the widgets cached on host pages and for self-hosted workers.

### Risks

- **A colour is written into a style.** `style.setProperty` cannot leave its declaration, but a value
  like `var(--x)` or `url(…)` would still be read. Hence `#rrggbb` only, checked on both ends; a line
  in [SECURITY.md](../../SECURITY.md) in the same commit.
- **The contract grows.** Two optional fields, tolerant reads, no version bump. The danger is the
  next field: the amended FRU-24 rule must still refuse a constant in a type.
- **A Linear state changes with no webhook.** The cost is a console page that shows the old list
  until it is opened again. A pin is never wrong, because the state comes with the issue.
- **Several connectors on one site.** Keys are qualified by the connector; a list for one site can
  hold twenty statuses. The filters stay on five stages so that the panel does not grow with them.
- **Who changes a status in the own store.** A new write on notes: `manage-feedback`, audited like
  the other writes of the console. Two people changing one note: last write wins, as for the verdict.
- **Translations.** A status the team names is shown as typed, like `stateName` now. A built-in
  status with no name keeps the catalog word, translated.
- **The extension and the console keep copies of the tokens.** A status colour is not a token, so it
  adds nothing to `design-tokens.test.ts`; the computed text colour is shared code instead.
- **GitHub Projects** would change the permissions of the App, and every installation would have to
  approve. Hence out of the first round.

### Sub-tickets

| #   | Ticket                                                                                                                                                | Critical | Why                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------- |
| 1   | `shared`: `statuses` and `status` in the envelope, `offeredStatuses`, the text colour function and its tests; rewrite the FRU-24 rule in contract.md. | **Yes**  | Public contract                       |
| 2   | Worker: table `statuses`, `seeds.status_key`, copy of the FRU-102 exceptions, read of the table first. SECURITY.md line on colours.                   | **Yes**  | Data migration                        |
| 3   | Worker: console API to read and write the statuses of a connector and of the own store (`manage-workspace`), with the 4.5:1 refusal.                  | **Yes**  | New writes, roles                     |
| 4   | Worker, Linear: read `color`, send `statuses` and `status`, « Use Linear's colours ».                                                                 | No       | Read path only                        |
| 5   | Worker, GitHub: the four fixed statuses, renamable and recolourable.                                                                                  | No       | Read path only                        |
| 6   | Worker, own store: the five built-in statuses, the statuses of the team, and the route that changes the status of a note.                             | **Yes**  | Writes a note, and its stage with it  |
| 7   | Widget: pin, thread, list and export draw the status; fallback to the stage; contrast tests. `/tfp`.                                                  | No       | Display; the fallback is covered by 1 |
| 8   | Extension: carry `status` (and `stateName`) in `PanelNote`; side panel and popup draw the status. `/tfp`.                                             | No       | Display                               |
| 9   | Console: board in `design/`, then the statuses screen of a connector and of the own store, the status select in the list of notes. `/tfp`.            | No       | Display, behind the routes of 3 and 6 |
| 10  | Later, on demand: REST receiver reports a status (signed inbound route).                                                                              | **Yes**  | New route open to the internet        |
| 11  | Later, on demand: GitHub Project v2 Status field.                                                                                                     | No       | App permission change, GraphQL        |

Order: 1, then 2, then 3 to 6 in any order, then 7 to 9. 10 and 11 wait for a request.

### Questions for Mathieu

1. **Can the read carry a colour and a name chosen by the team?** It means rewriting the FRU-24 rule
   from « no colour in the contract » to « no colour **constant** in the contract ». Recommendation:
   yes. The other way is to send only a status key and let each surface ask the console for colours,
   which is a second request on every page and a second cache to keep in step.
2. **Per connector, or per site?** The ticket says « per site or per workspace ». Recommendation: per
   connector (and the own store per workspace), because the states are the tracker's and every site
   that sends to it sees the same board. A per-site override can come later if a client asks for it.
3. **Default colours: FRU-334, or the tracker's?** Recommendation: FRU-334 by default, so every site
   looks like Fruitback, and one switch per connector, « Use Linear's colours », off by default.
4. **GitHub labels as statuses?** Recommendation: no, as FRU-32 decided. Four fixed GitHub statuses
   now, and the Status field of a GitHub Project later if a client asks.
5. **REST: is « the receiver says the status » wanted now?** It needs a signed inbound route, a new
   surface open to the internet. Recommendation: not now. A REST site gets the statuses of the
   worker's own store, which the team sets and changes in the console; the inbound route is a
   critical ticket of its own when a receiver needs it.
