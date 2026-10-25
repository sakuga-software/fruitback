# The note contract

`packages/shared` is what both ends depend on. The invariants open the section, in short;
after them is what each of them cost to establish, and what FRU-24 took out of the contract before the
first publish made it expensive.

## The note contract

### The rules, in short

- **The contract holds the vocabulary and no fixed value a human reads** (FRU-24, FRU-364). No
  emoji, no English label, no fixed colour: those are rendering decisions, and a published type is
  the one place they can never be changed or translated downstream. A name or a colour that a team
  chose for its site may travel as **data** in the read envelope (`statuses`): the schema holds the
  field, never a value. See [statuses.md](statuses.md).
- **A status belongs to a stage, and the stage wins** (FRU-364). `statuses` and `status` are
  read-envelope fields, so `NOTE_VERSION` does not move. `offeredStatuses` reads the list
  tolerantly and keeps only `#rrggbb` colours; `statusOf` gives an issue its status only when that
  status has the issue's stage, so a widget that reads only `stage` draws what one that reads the
  status draws.
- **A store can report only some stages, and says which** (FRU-32). `NoteStore.stages` travels as
  `stages` on every `GET /feedback`, with or without pins — derived from the pins on screen, an empty
  page would offer the wrong boxes. `offeredStages` reads it tolerantly and answers every stage when
  the field is absent. GitHub reports `new`, `done` and `closed`. A read-envelope field, so
  `NOTE_VERSION` does not move.
- **A read says `identified: true` to a reader whose token the worker verified** (FRU-112), and
  leaves the field out for everybody else. Only `true` is the word of the worker. It says that a note
  of this reader would be signed by the worker, never who the reader is. A read-envelope field too.
- **A note is `fruitback.note` at version 3, and nothing else reads as one** (FRU-378, decided by
  Mathieu on 2026-10-25). The words of the reporter are in `text`. `parseNote` reads that kind and
  version only: a payload of another kind is `not-found`, a newer version `unsupported-version`. The
  payloads of before were rewritten once by `rewrite-notes` of the worker 0.4.0, which held the only
  reader of them; FRU-449 removed both. `@fruitback/shared` 0.4.0 exports no name of before.
- **The wire says `note`, and only `note`** (FRU-378). Each issue of `GET /feedback`, each row of
  `GET /session/notes` and each REST delivery (version 2) carry the note under `note`. A refused
  note is `invalid-note`. An answer of the read cache of before is under another prefix of the `Kv`
  (`read-v3`), where no reader looks.
- **An issue says `checked: { by, at }` and `mine: true`** (FRU-294): `checked` on a done note whose
  newest verdict in its replies is « looks fixed », `mine` to the reader who left the note. Both
  optional, both read-envelope fields: `NOTE_VERSION` does not move.

### The reasons, and the history

`packages/shared` is the contract both ends depend on. Treat changes to it as breaking.

- A **note** is one pin: `text`, `page`, `viewport`, `anchor`, plus optional `source` (react-grab),
  `client`, `reporter`, `env`, `screenshot`.
- **The round-trip is the invariant**: `parseNoteFromDescription(buildIssueDescription(note))` must
  return exactly `note`. Two rules protect it — **no schema default values**, and no field the
  widget cannot rebuild from what is stored. Adding a default is the easy way to break this
  silently; test:`adds no field the caller did not provide` is there to catch it.
- **Bump `NOTE_VERSION`** when the payload shape changes — it is `3` since FRU-378 named the kind
  `fruitback.note`. Readers refuse a newer version (`unsupported-version`) rather than silently
  drop fields; a version before 3 is `invalid`, since no writer of this kind made one.
- **`parseNote*` never throws.** It returns `{ ok: false, reason }` — the input is a Linear
  description a human may have edited.
- `canonicalizePageUrl` is the page identity: fragment and tracking params dropped, remaining params
  sorted. It must stay idempotent, and its output must appear verbatim in the description — that is
  what makes the Linear `description: { contains: … }` filter work.
- Pin colour comes from a `NoteStage`, and the widget never stores a status of its own — it renders
  the one the store reports.
- **The contract holds the vocabulary and no fixed value a human reads** (FRU-24). The stage styles used
  to sit in `shared` carrying an `emoji`, a `label` and a `color` per stage — a published type nobody
  downstream could change, holding three decisions that were never the contract's:
  - `color` was already dead, moved to the widget's `--fruitback-stage-*` tokens by FRU-35 and read
    by nothing since. Deleting a field nobody reads is the cheap half.
  - `emoji` was a **rendering decision travelling in a type**. The widget could not drop it without a
    major version, and a consumer could not replace it at all. It is the widget's now, and by default
    there is no glyph: the pin's drop shape and its stage colour carry the stage. The `≈` on an unsure
    pin stays — it is a typographic symbol and the whole warning in one character.
  - `label` was an English string in a contract, which is untranslatable by anyone downstream. The
    widget keeps its own words for the stages — `stages.ts` then, the `stage.*` keys of `messages.ts`
    since FRU-37, where they can be translated; each store names its own states in
    `stateName`, which is what `sqlite.ts` now does with a local map rather than a shared one.
- **Doing this before the first publish cost nothing.** Removing a field from a published type is a
  major version; FRU-24 blocks FRU-28 for exactly that reason.
- **`NOTE_BLOCK_CAPTION` is free to reword, and that is now asserted rather than believed.** It is
  written into every issue description, so whether the parser depends on it decides whether it can
  ever change. It does not — `parseNoteFromDescription` iterates fenced blocks and recognises ours by
  parsing the JSON. The test
  test:`finds the block by its JSON, never by the caption above it (FRU-24)` fails if
  that stops being true, which is what made dropping its emoji safe instead of hopeful. Since FRU-39
  the caption is translated with the rest of the prose, and that test is what makes translating it
  safe: the parser never looks at it.
- **The two layers are what makes a translated description possible** (FRU-39). The prose on top is
  written for the team that triages, in the worker's `FRUITBACK_TEAM_LOCALE`; the JSON block under it
  is the widget's, and no language reaches it. So
  `parseNoteFromDescription(buildIssueDescription(note, { locale })) === note` holds in every
  language, and the round-trip test runs over several. **That is a constraint to hold rather than a
  fact to lean on**: a translated key in the block, or a parser that looked for the caption, would
  break it in silence. The reporter's own words — the note, the name they typed — are never
  translated either; what is translated is the worker's word **about** that name, `verified` or
  `unverified — self-declared`.
- **A test whose premise disappeared was rewritten, not deleted.** gone-test:`redraws when a note changed
  stage, because its emoji did` could no longer hold: nothing in the orphan entry depends on the stage
  now. What it really guarded — that the signature invalidates on a stage change — is still worth
  keeping, so it asserts a **rebuilt node** instead of different text. The signature deliberately
  over-invalidates by one field, because FRU-36 decides how a stage shows up there and a signature
  that had forgotten it would leave a stale entry. **FRU-36 answered**: each row carries a drop in
  its stage's colour, so the signature is honest and the test asserts the colour rather than a
  rebuilt node.
- **The six emoji FRU-24 left behind were FRU-36's, and there are none now.** They were standalone
  literals in the widget's own copy — the launch label, the gear, the settings title, the
  detached-notes count, the harvested state — rather than anything the _contract_ was dictating,
  which is why FRU-24 scoped them out. See _No emoji, and what replaced them_
  ([icons.md](icons.md)). The count in this paragraph was wrong twice before it was right, so do not
  trust a number here: `icons.test.ts` asserts zero across the package, and it was measured failing
  on a planted one.
- **The stage vocabulary is the contract's; the projection onto it is the connector's** (FRU-23).
  `NOTE_STAGES` and `DEFAULT_NOTE_STAGE` live in `shared`; `stageForLinearState` and
  `LINEAR_STATE_TYPES` moved to `apps/worker/src/linear.ts`, where Linear's vocabulary belongs.
  Naming one provider's states in the contract made every consumer of the published package depend
  on that provider, and GitHub's projection did not resemble Linear's (FRU-32).
- **A connector may report only some stages, and the read says which** (FRU-32). GitHub has two issue
  states and a reason on a close, which gives three stages. `NoteStore.stages` is sent as `stages` on
  every `GET /feedback`, and the settings panel offers a box only for those. It is part of the read
  envelope, not of the note, so `NOTE_VERSION` does not move. `offeredStages` is tolerant like
  `parseNote*`: a missing, malformed or empty list means every stage, which is what a worker from
  before the field sends. The vocabulary stays five stages; a connector narrows what it uses, and
  never adds one.
- The fallback for an unrecognised state stays in `shared` on purpose. A connector spelling
  `'new'` itself is how the next one comes to disagree, and an unknown state must colour the pin
  rather than hide someone's note.
