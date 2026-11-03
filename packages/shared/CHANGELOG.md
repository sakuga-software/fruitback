# @fruitback/shared

## 0.7.0

### Minor Changes

- 86c5798: `@fruitback/shared` exports the messages between the console and the extension of the same browser: `EXTERNAL_VERSION`, `EXTERNAL_TYPES`, the types `ExternalAsk` and `ExternalAnswer`, the lists `EXTERNAL_CONNECT_STATES` and `EXTERNAL_REFUSALS`, and `parseExternalAnswer`. The console reads each answer of the extension through it in place of casts, and the extension answers with the same types. The messages themselves do not change.
- e3fea3b: A note on an element inside a web component (an open shadow root) pins on that element again. The anchor carries an optional `hosts`: one selector for each shadow host between the document and the element, outermost first, and `selector`, `domPath`, `text` and `tag` are then read in the last shadow root. The widget writes it at capture and follows it when it places a pin; when a host is gone or its shadow root is closed, the pin falls back to its position and says so. `@fruitback/shared` exports `anchorSelectorPath`, which writes the hosts and the selector as one line (`#promo >>> button.buy`) in the issue description, the text of a page and the thread. Pointing at an element inside two nested open shadow roots no longer overflows the stack: the widget walks them itself, where react-grab 0.2.0 recursed for ever. A note without `hosts` reads and resolves as before, and `NOTE_VERSION` stays 3: a widget of before drops the field and places the pin as it did.
- 9b7ed99: `@fruitback/shared` exports how a note is painted and named, and the core of the words of the console and the extension, written once: `STATUS_INK`, `paintOfStatus(color, textColor)`, `statusLabel(statusName, stateName, stageWord)`, `nearestLanguage(tag, languages, fallback)` and `fillSentence(sentence, values)`. The widget, the extension, the console and the worker use them in place of their own copies; what each draws and says does not change.

### Patch Changes

- e0e3ad1: The tools of `/mcp` say « note », as the contract does: `list_feedback` is `list_notes`, `get_feedback` is `get_note`, `feedback_as_text` is `notes_as_text`, `reply_to_feedback` is `reply_to_note`, and `set_feedback_status` is `set_note_status`. The old names are gone, with no alias: an agent that is already configured must reload its tools. `notes_as_text` titles a page « Notes on {url} », as the widget does, and an issue with no text is titled « Note on <tag> — path ».

## 0.6.0

No changes in this release.

## 0.5.0

### Minor Changes

- 106f528: A reply can say `by: 'agent'`: an AI agent wrote it through `/mcp`, with an agent key of the workspace. The field is optional, and a widget that does not read it shows the name of the reply alone. The worker gives an agent key with the right `write` two tools, `reply_to_feedback` and `set_feedback_status`, limits each key to 30 writes a minute, and keeps a log of the writes of each key, which the owner and the admins read in the console API.
- ec76366: The author of a note edits its text from its thread while nobody of the team moved it: « Edit », then « Save » or « Cancel », in English and in French. A read says `editable: true` on such a note. Only a note that the worker keeps can be edited; a note sent to a tracker or to an address cannot.
- 5e1e3a0: The worker serves `POST /mcp`, a remote MCP server for an AI agent with an agent key of a workspace: `list_feedback`, `get_feedback` and `feedback_as_text` read the notes of the sites of the key, with their whole content. `@fruitback/shared` exports `feedbackText`, the plain text of the notes of a page that « Copy as text » writes, with the words given by the caller. `feedbackAsText` of the widget answers the same text as before.

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
