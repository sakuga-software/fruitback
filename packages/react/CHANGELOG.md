# @fruitback/react

## 0.9.0

### Patch Changes

- Updated dependencies [87b59e4]
- Updated dependencies [0dcf745]
- Updated dependencies [2a54654]
- Updated dependencies [5925594]
- Updated dependencies [cdc234d]
- Updated dependencies [57a3835]
  - @fruitback/widget@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [4e3ad70]
- Updated dependencies [57bb8e5]
- Updated dependencies [21aa779]
- Updated dependencies [4e2f1df]
- Updated dependencies [6535b23]
- Updated dependencies [1a60ff2]
- Updated dependencies [880d540]
- Updated dependencies [3d4f2eb]
- Updated dependencies [26f4598]
- Updated dependencies [f48ad10]
- Updated dependencies [c7d700b]
- Updated dependencies [9ff903d]
- Updated dependencies [132f13b]
- Updated dependencies [52fa16d]
- Updated dependencies [2dd49ea]
- Updated dependencies [04b7b96]
- Updated dependencies [fbeaa0f]
- Updated dependencies [a1877fe]
- Updated dependencies [4b78560]
- Updated dependencies [66f4f52]
- Updated dependencies [5f5e51e]
- Updated dependencies [4ddc561]
- Updated dependencies [5aa014f]
- Updated dependencies [9159f49]
- Updated dependencies [d6b3084]
- Updated dependencies [aba9530]
- Updated dependencies [023a84b]
- Updated dependencies [d96c822]
- Updated dependencies [73281a2]
  - @fruitback/widget@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [46c608c]
- Updated dependencies [09282fc]
- Updated dependencies [0255b8b]
- Updated dependencies [64a50c4]
- Updated dependencies [bf65df2]
- Updated dependencies [e3fea3b]
- Updated dependencies [51a498f]
- Updated dependencies [9b7ed99]
- Updated dependencies [88971e2]
  - @fruitback/widget@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [9bc7374]
  - @fruitback/widget@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [aa1688d]
- Updated dependencies [c17cb4e]
- Updated dependencies [389ac28]
- Updated dependencies [b702ee6]
- Updated dependencies [ec76366]
- Updated dependencies [5e1e3a0]
- Updated dependencies [7cce931]
- Updated dependencies [fde538c]
- Updated dependencies [d0216b5]
- Updated dependencies [c14db05]
  - @fruitback/widget@0.5.0

## 0.4.0

### Minor Changes

- 504d911: **Breaking: a note is `fruitback.note`, version 3, and the word « seed » is gone (FRU-378).**

  - `@fruitback/shared` exports `Note`, `noteSchema`, `createNote`, `parseNote`, `parseNoteFromDescription`, `buildNoteBlock`, `NOTE_KIND`, `NOTE_VERSION`, `NOTE_STAGES` and the other `note` names, and `@fruitback/shared/note.fixture`. The names of 0.3.0 are removed: `Seed`, `SeedIssue`, `seedSchema`, `createSeed`, `parseSeed`, `parseSeedFromDescription`, `SEED_KIND`, `SEED_VERSION`, `@fruitback/shared/seed.fixture` and the other `seed` names.
  - A note is written and read as `{ "kind": "fruitback.note", "v": 3, …, "text": … }`: the words of the reporter are in `text`. `parseNote` reads that kind and version only; a payload of `fruitback.seed` reads as `not-found`. A read answers each issue with its note under `note`.
  - The worker answers `note` only: in each issue of `GET /feedback`, in each row of `GET /session/notes`, and in the REST delivery, whose `version` is now 2. A refused note is `invalid-note`. The commands take `forget --note` and `migrate-to-postgres --notes`.
  - `node server.mjs rewrite-notes [--dry-run]` rewrites once the notes written before 0.4.0, in the issues of Linear and GitHub, in the database and in the queue of deliveries. Run it right after the upgrade: `docs/self-hosting/upgrade.md`.
  - The widget keeps the notes for later under a new key of `sessionStorage`: the drafts kept by 0.3.0 are left.
  - The extension 0.3.0 does not read the notes of a 0.4.0 worker, and a widget 0.3.0 can neither send a note to it (`invalid-note`) nor draw its pins: update the worker, the widget and the extension together.

### Patch Changes

- 54fc764: Each package has a README on npm: how to install it, a minimal example, the guides to read next, and its licence.
- Updated dependencies [f3528ad]
- Updated dependencies [aa59f54]
- Updated dependencies [6db8c4f]
- Updated dependencies [76b9203]
- Updated dependencies [582e1d4]
- Updated dependencies [f6c763f]
- Updated dependencies [504d911]
- Updated dependencies [54fc764]
- Updated dependencies [93f83f8]
- Updated dependencies [a82f0d8]
- Updated dependencies [9bcb61e]
- Updated dependencies [c5cf3bb]
- Updated dependencies [0c20347]
- Updated dependencies [60c651f]
- Updated dependencies [38a87a9]
  - @fruitback/widget@0.4.0
