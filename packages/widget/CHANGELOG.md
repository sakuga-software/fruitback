# @fruitback/widget

## 0.5.0

### Minor Changes

- aa1688d: A reply that an AI agent wrote (`by: 'agent'`) says « Agent » beside the name of its key in the thread of a note, in English and in French.
- c17cb4e: `init` takes `siteNotes`, the notes of every page of the site for a host that can read them. The list then offers « All pages » beside « This page »: a search through the host, « Show more », and a row that opens the page of its note.
- b702ee6: The settings of the widget offer « Position » under « Pins shown »: the reporter moves the dock to any corner of the window. The choice is kept for the site in this browser and beats the `position` of `init`; a later `moveDock()` of the host forgets it.
- ec76366: The author of a note edits its text from its thread while nobody of the team moved it: « Edit », then « Save » or « Cancel », in English and in French. A read says `editable: true` on such a note. Only a note that the worker keeps can be edited; a note sent to a tracker or to an address cannot.
- c14db05: `init` takes `openSidebar`: the button of the dock that shows every note asks the host for its side panel first, and opens the list of the page when the host cannot. The widget the extension mounts opens the side panel of the browser with it.

### Patch Changes

- 389ac28: The composer that follows its element at a scroll moves by as much as the element, and keeps its side: it no longer jumps below an element that shifted by a pixel as the page scrolled.
- 5e1e3a0: The worker serves `POST /mcp`, a remote MCP server for an AI agent with an agent key of a workspace: `list_feedback`, `get_feedback` and `feedback_as_text` read the notes of the sites of the key, with their whole content. `@fruitback/shared` exports `feedbackText`, the plain text of the notes of a page that « Copy as text » writes, with the words given by the caller. `feedbackAsText` of the widget answers the same text as before.
- 7cce931: The frame of a capture and the composer stay on an element that does not scroll with the page, such as a link of a fixed sidebar, instead of scrolling away from it. `Composer.open` also takes the element itself, and then follows it.
- fde538c: The frame of a capture and the composer stay on an element that is smaller while it is pressed, such as a button drawn at `scale(0.97)` under `[data-pressed]`. They were placed on the pressed box and stayed about 1 px off once the button was released. They now follow the box of the element for the few frames after the choice, until it stays the same (200 ms, at most 1 s). In a right-to-left language the composer keeps to the right edge of its element.
- d0216b5: The dock fades in when the widget mounts, the settings and the thread of a note fade in when they open, and a button of the dock gives way a little under a press. Nothing moves for a person who asked the system for less motion.
- Updated dependencies [106f528]
- Updated dependencies [ec76366]
- Updated dependencies [5e1e3a0]
  - @fruitback/shared@0.5.0

## 0.4.0

### Minor Changes

- aa59f54: The widget handle gains `captureArea()`. It starts « Capture an area » in the open composer, or starts a note when no composer is open. The browser extension calls it from its context menu item « Capture with Fruitback ».
- 582e1d4: `init` takes `position`, the corner of the window the dock stands in: `bottom-right` (the default), `bottom-left`, `top-right` or `top-left`. The settings open from that corner. A script tag says it with `data-fruitback-position`. The handle gains `moveDock(position)`, which moves the dock without building the widget again, so a note being written stays. With no `position`, the dock stays where it was, at the bottom on the side where lines end.
- 504d911: **Breaking: a note is `fruitback.note`, version 3, and the word « seed » is gone (FRU-378).**

  - `@fruitback/shared` exports `Note`, `noteSchema`, `createNote`, `parseNote`, `parseNoteFromDescription`, `buildNoteBlock`, `NOTE_KIND`, `NOTE_VERSION`, `NOTE_STAGES` and the other `note` names, and `@fruitback/shared/note.fixture`. The names of 0.3.0 are removed: `Seed`, `SeedIssue`, `seedSchema`, `createSeed`, `parseSeed`, `parseSeedFromDescription`, `SEED_KIND`, `SEED_VERSION`, `@fruitback/shared/seed.fixture` and the other `seed` names.
  - A note is written and read as `{ "kind": "fruitback.note", "v": 3, …, "text": … }`: the words of the reporter are in `text`. `parseNote` reads that kind and version only; a payload of `fruitback.seed` reads as `not-found`. A read answers each issue with its note under `note`.
  - The worker answers `note` only: in each issue of `GET /feedback`, in each row of `GET /session/notes`, and in the REST delivery, whose `version` is now 2. A refused note is `invalid-note`. The commands take `forget --note` and `migrate-to-postgres --notes`.
  - `node server.mjs rewrite-notes [--dry-run]` rewrites once the notes written before 0.4.0, in the issues of Linear and GitHub, in the database and in the queue of deliveries. Run it right after the upgrade: `docs/self-hosting/upgrade.md`.
  - The widget keeps the notes for later under a new key of `sessionStorage`: the drafts kept by 0.3.0 are left.
  - The extension 0.3.0 does not read the notes of a 0.4.0 worker, and a widget 0.3.0 can neither send a note to it (`invalid-note`) nor draw its pins: update the worker, the widget and the extension together.

- 93f83f8: A screenshot pasted in the composer (⌘V or Ctrl+V) joins the note as an attachment, with the same limits as a file chosen. A paste that carries text stays a paste of text. The drop zone says that a screenshot can be pasted.
- a82f0d8: A pin under a mouse, or with the focus of the keyboard, shows a preview of its note: its state, its identifier in the tracker, its first two lines, and how to open it. It replaces the tooltip of the browser. A tap opens the thread as before, with no preview.
- 9bcb61e: `init({ selectorInHead: 'with-selectors' })` writes the selector of the element in the head of the composer only while `showSelectors` is on, and what a person reads for the element otherwise. The default, `always`, keeps the head as it was.
- 0c20347: The bubble of a note opens under its element, above it or beside it, where the window has the room, and no longer covers what the note is about. An arrow on its edge points at the pin. An element that leaves the room on no side gets the bubble beside its pin, as before.
- 60c651f: The bubble of a note on the page moves by a handle at the start of its head: by a pointer, by the arrow keys (16 px, 48 px with Shift), and back to its place with Home or a double click. A dashed line joins it to its pin while it is away, and it follows its pin when the page scrolls. The move is forgotten when the bubble closes.

### Patch Changes

- f3528ad: The menu « Attach » of the composer floats under its button, or above it at the foot of the window, and the composer keeps its size when it opens.
- 6db8c4f: A capture that the browser refused for want of a gesture on the extension now says « Click the Fruitback icon in the toolbar, then try again. » instead of « The capture was not taken ». A host signals this refusal by rejecting `captureVisible` with an error named `NotAllowedError`. Any other failure keeps the message of before.
- 76b9203: The composer is built element by element instead of from an HTML string given to `innerHTML`. Nothing changes on screen. A page whose Content Security Policy requires Trusted Types no longer refuses it, and the validator of addons.mozilla.org no longer flags it.
- f6c763f: A note refused because the site takes notes from its members only, and the page sent no session of a member, now says so and asks to sign in from the Fruitback extension, rather than "try again". The list of notes says the same when the read is refused for that reason, and offers no "Try again". The text of the note is kept, as in every failure.
- 54fc764: Each package has a README on npm: how to install it, a minimal example, the guides to read next, and its licence.
- c5cf3bb: The status chips of the list put a space between their word and their number. The visible text now holds the same words as the accessible name « All 8 », which axe-core 4.14 asks for.
- 38a87a9: The bubble of a note keeps its close button at the top on the right: the head is two columns, and the state and the link wrap in the first. The age of the status leaves the head for the title of the status word. The selector and the source show only with `showSelectors`, as discreet lines of mono, and a note with no reply shows no « Replies » section.
- Updated dependencies [504d911]
- Updated dependencies [54fc764]
  - @fruitback/shared@0.4.0
