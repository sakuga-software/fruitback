# @fruitback/shared

## 0.9.0

### Minor Changes

- 0dcf745: A site can keep every version of its notes: « Keep every version », the third line of the card « Safeguards » in its tab « Access », on by default. An edit of the text of a note keeps the text of before, and a deletion keeps the note as it was, with who did it and when. The members of the workspace read them in a section « History » of the panel of the note; a guest reads none. The widget tells the author, in the form of an edit, that the team keeps the text of before (`versionsKept` of a read). A note keeps 50 versions at most, and they go with the note.
- 5925594: A member changes the status of a note from the head of its thread: the chip of the status becomes a button with a chevron, and its menu lists the five stages, the one of the note checked. The widget sends the built-in status of the stage through `POST /feedback/<id>/status`, the route the console and the extension already had, with its rights: the person who left the note or a role that manages the sites, with a session. The read says `canSetStatus` on each note the reader may move, after the cache. A visitor, a guest with no right on the note and a note of a tracker keep the status read only. The extension relays `/feedback/<id>/status` with the session.

## 0.8.0

### Minor Changes

- 57bb8e5: The thread of a note says « An agent is working on this note » when a call of the site's trigger started a Claude Code routine session for it. A member of the team who can see the tracker also gets « Open the session », a link to that session. Guests, reviewers and visitors see the line without the link. The read gives `agent: {}`, or `agent: { url }` to a member of the team. Only `https` addresses are given.
- 3d4f2eb: On a phone, « Send » takes the whole width of the sheet, every target of the composer is 44 px, and the element stays in sight: the page scrolls it above the sheet, or the sheet stands on the top when the page cannot scroll that far. The lists say « 99+ » above 99 in a tab, a chip and a scope, and « To check » always exactly (`shortCount` of `@fruitback/shared`). A long host is cut at its start, in the list of the widget, the popup and the side panel, with the whole host in its tooltip. The widget reads a page ground on one canvas per document.
- c7d700b: The list of the notes has three tabs that follow the loop, in the widget and in the side panel of the extension: « To check », « Open » and « Done ». « To check » holds the notes of the reader that the team marked done and nobody confirmed; it replaces the block « Ready to check » above the tabs. The list opens on « To check » while a note waits there. In the widget, the search, the scope and the chips move behind « Search and options », the magnifier of the head, as in the side panel. `noteTab` and `firstTab` of `@fruitback/shared` sort a note into its tab.
- 2dd49ea: A note in the list says the stage of Fruitback first and the tracker second, « In progress · Linear: In Review », after a round that fills as the note moves on: a dashed ring for New, an empty one for To do, half full for In progress, full with a tick for Done, with a cross for Closed (`createStageRing`). The filter of the list keeps its shape: All and the five stages, Closed too, in the widget and the side panel; the list of statuses that took the place of the chips beyond five statuses is gone, and the search finds the name of a status or the word of a tracker. `trackerOf`, `stageFirstLabel` and `TRACKER_NAMES` of `@fruitback/shared` name the tracker of an issue by its address.
- 687ed1f: A task is copied as its link, its ID or Markdown for an agent, from its menu, its panel, Cmd/Ctrl+Shift+C and Cmd/Ctrl+Shift+. The tool `notes_as_text` of a whole site ends with its tasks written by hand.
- 01b7b9b: A task is written by hand in the console, with a title and, if you like, a text, a status and its fields. It has no page and no pin.
- 04b7b96: `@fruitback/shared` exports `RESOLVED_STAGES`, the stages done and closed. The widget's `RESOLVED_STAGES` is now that same list, re-exported, and stays a public export. The console reads it for its « Unresolved » filter of the status.
- d96c822: The author of an open note can withdraw it from « ⋯ » in its thread. The thread asks first, then closes the note, and nothing is deleted. A reply under the note says who withdrew it. On Linear, the issue gets the same reply as a comment and moves to the team's first canceled state. An address receives a new `note.withdrawn` event, which carries identifiers only, and the console lists it with the other deliveries. The read gives `withdrawable: true` for the note the reader may withdraw. Notes sent to GitHub cannot be withdrawn.

### Patch Changes

- 73281a2: The script of the widget is 66 kB lighter gzipped (198 kB to 132 kB). The note contract imported zod as one named value, so the bundle kept all of zod: about 50 locales of error messages and the JSON Schema converters, which the widget never uses. It now imports zod as a namespace, which the bundler can trim. The schemas, and the English messages of zod, are the same.

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
