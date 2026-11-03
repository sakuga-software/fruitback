# @fruitback/widget

## 0.7.0

### Minor Changes

- 46c608c: The English of the widget says « note », as its French does: the button is « Leave a note » (was « Leave feedback »), the widget is named « Fruitback notes », the field of a note is « Your note », the settings say « Statuses shown », « Hide resolved notes » and « Copy the notes as text », and the copied text starts with « Notes on {url} ». A host that overrides these keys through `init({ messages })` keeps its own words; a test or a script that finds the button by « Leave feedback » needs the new name.
- 09282fc: `@fruitback/widget` exports `RELATIVE_UNITS`, the units its relative dates count in, from a module of its own. The extension counts the ages of its side panel with them, and relays files with the widget's `base64OfBytes` and `bytesOfBase64` in place of its copies. Nothing it shows or sends changes.
- e3fea3b: A note on an element inside a web component (an open shadow root) pins on that element again. The anchor carries an optional `hosts`: one selector for each shadow host between the document and the element, outermost first, and `selector`, `domPath`, `text` and `tag` are then read in the last shadow root. The widget writes it at capture and follows it when it places a pin; when a host is gone or its shadow root is closed, the pin falls back to its position and says so. `@fruitback/shared` exports `anchorSelectorPath`, which writes the hosts and the selector as one line (`#promo >>> button.buy`) in the issue description, the text of a page and the thread. Pointing at an element inside two nested open shadow roots no longer overflows the stack: the widget walks them itself, where react-grab 0.2.0 recursed for ever. A note without `hosts` reads and resolves as before, and `NOTE_VERSION` stays 3: a widget of before drops the field and places the pin as it did.

### Patch Changes

- 0255b8b: The French of the widget follows one glossary: a pin is a « repère » (« Note 3, statut nouveau » in place of « Note 3, nouveau »), an issue a « ticket », and a session that ended « a pris fin ». French is set with a narrow no-break space before « : », « ; », « ? », « ! » and « », and after « «, so a line never breaks there. A host that passes its own French through `init({ messages })` keeps its own words and spaces.
- 64a50c4: A detached note says the word of its state as its pin does: the name of its status, else the name of its state in the tracker (« Shipped to prod »), else the word of its stage. It said the word of the stage, and missed the name the tracker gives.
- bf65df2: The messages of a note, a reply or an edit that did not go say what to do next, with no dash: « Not sent. Your text is still here. Try again. » in place of « Did not go through — your text is kept, try again ». A file whose bytes do not match its type, or that did not upload, says how to fix it; the foot of the composer reads « Creates a new issue in {destination} »; and « Pick again » is « Choose another element ». A host that overrides these keys through `init({ messages })` keeps its own words.
- 51a498f: A pin on an element inside a web component finds its element when the component draws its content after the widget placed the pins. The widget observes the open shadow roots that the `hosts` of the notes on the page go through, and waits for a custom element that is not defined yet. Before, the pin stayed an orphan until the document changed or the window resized. A note without `hosts` is resolved as before.
- 9b7ed99: `@fruitback/shared` exports how a note is painted and named, and the core of the words of the console and the extension, written once: `STATUS_INK`, `paintOfStatus(color, textColor)`, `statusLabel(statusName, stateName, stageWord)`, `nearestLanguage(tag, languages, fallback)` and `fillSentence(sentence, values)`. The widget, the extension, the console and the worker use them in place of their own copies; what each draws and says does not change.
- 88971e2: Internal tidy of the widget, with no change to what it shows or does: the CSS of each part moves to its own `*.styles.ts`, the calls to the worker go through one `worker-client.ts`, and the excerpt of a note, the date of a row and the failures of a write are written once. `init`, its options and the exported names do not change.
- Updated dependencies [86c5798]
- Updated dependencies [e0e3ad1]
- Updated dependencies [e3fea3b]
- Updated dependencies [9b7ed99]
  - @fruitback/shared@0.7.0

## 0.6.0

### Patch Changes

- 9bc7374: The widget keeps its styles on a page whose Content Security Policy refuses inline styles (`style-src 'self'`): each part adopts its stylesheet into the Shadow root in place of a `<style>` element, which such a page refused. There, the widget showed the browser's own buttons.
- @fruitback/shared@0.6.0

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
