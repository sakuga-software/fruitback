# The seed contract

`packages/shared` is what both ends depend on. The invariants are in [CLAUDE.md](../../CLAUDE.md);
here is what each of them cost to establish, and what SKG-517 took out of the contract before the
first publish made it expensive.

## The seed contract

`packages/shared` is the contract both ends depend on. Treat changes to it as breaking.

- A **seed** is one pin: `note`, `page`, `viewport`, `anchor`, plus optional `source` (react-grab),
  `client`, `reporter`, `env`, `screenshot`.
- **The round-trip is the invariant**: `parseSeedFromDescription(buildIssueDescription(seed))` must
  return exactly `seed`. Two rules protect it — **no schema default values**, and no field the
  widget cannot rebuild from what is stored. Adding a default is the easy way to break this
  silently; the test `adds no field the caller did not provide` is there to catch it.
- **Bump `SEED_VERSION`** when the payload shape changes — it is `2` since SKG-498 added
  `reporter.verified`. Readers accept older versions and refuse
  newer ones (`unsupported-version`) rather than silently dropping fields.
- **`parseSeed*` never throws.** It returns `{ ok: false, reason }` — the input is a Linear
  description a human may have edited.
- `canonicalizePageUrl` is the page identity: fragment and tracking params dropped, remaining params
  sorted. It must stay idempotent, and its output must appear verbatim in the description — that is
  what makes the Linear `description: { contains: … }` filter work.
- Pin colour comes from a `SeedStage`, and the widget never stores a status of its own — it renders
  the one the store reports.
- **The contract holds the vocabulary and nothing a human reads** (SKG-517). `SEED_STAGE_STYLES` used
  to sit in `shared` carrying an `emoji`, a `label` and a `color` per stage — a published type nobody
  downstream could change, holding three decisions that were never the contract's:
  - `color` was already dead, moved to the widget's `--fruitback-stage-*` tokens by SKG-528 and read
    by nothing since. Deleting a field nobody reads is the cheap half.
  - `emoji` was a **rendering decision travelling in a type**. The widget could not drop it without a
    major version, and a consumer could not replace it at all. It is the widget's now, and by default
    there is no glyph: the pin's drop shape and its stage colour carry the stage. The `≈` on an unsure
    pin stays — it is a typographic symbol and the whole warning in one character.
  - `label` was an English string in a contract, which is untranslatable by anyone downstream. The
    widget keeps its own `stages.ts`, ready for SKG-530; each store names its own states in
    `stateName`, which is what `sqlite.ts` now does with a local map rather than a shared one.
- **Doing this before the first publish cost nothing.** Removing a field from a published type is a
  major version; SKG-517 blocks SKG-521 for exactly that reason.
- **`SEED_BLOCK_CAPTION` is free to reword, and that is now asserted rather than believed.** It is
  written into every issue description, so whether the parser depends on it decides whether it can
  ever change. It does not — `parseSeedFromDescription` iterates fenced blocks and recognises ours by
  parsing the JSON. The test `finds the block by its JSON, never by the caption above it` fails if
  that stops being true, which is what made dropping its emoji safe instead of hopeful.
- **A test whose premise disappeared was rewritten, not deleted.** `redraws when a note changed
  stage, because its emoji did` could no longer hold: nothing in the orphan entry depends on the stage
  now. What it really guarded — that the signature invalidates on a stage change — is still worth
  keeping, so it asserts a **rebuilt node** instead of different text. The signature deliberately
  over-invalidates by one field, because SKG-529 decides how a stage shows up there and a signature
  that had forgotten it would leave a stale entry. **SKG-529 answered**: each row carries a drop in
  its stage's colour, so the signature is honest and the test asserts the colour rather than a
  rebuilt node.
- **The six emoji SKG-517 left behind were SKG-529's, and there are none now.** They were standalone
  literals in the widget's own copy — the launch label, the gear, the settings title, the
  detached-notes count, the harvested state — rather than anything the *contract* was dictating,
  which is why SKG-517 scoped them out. See *No emoji, and what replaced them*
  ([icons.md](icons.md)). The count in this paragraph was wrong twice before it was right, so do not
  trust a number here: `icons.test.ts` asserts zero across the package, and it was measured failing
  on a planted one.
- **The stage vocabulary is the contract's; the projection onto it is the connector's** (SKG-516).
  `SEED_STAGES` and `DEFAULT_SEED_STAGE` live in `shared`; `stageForLinearState` and
  `LINEAR_STATE_TYPES` moved to `apps/worker/src/linear.ts`, where Linear's vocabulary belongs.
  Naming one provider's states in the contract made every consumer of the published package depend
  on that provider, and GitHub's projection — two states plus labels — will not resemble Linear's.
- The fallback for an unrecognised state stays in `shared` on purpose. A connector spelling
  `'seeded'` itself is how the next one comes to disagree, and an unknown state must colour the pin
  rather than hide someone's note.

