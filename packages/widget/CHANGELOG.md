# @fruitback/widget

## 0.9.0

### Minor Changes

- 87b59e4: A site can hold the notes of its visitors for a member: « Hold new visitor notes », the second line of the card « Safeguards » in its tab « Access », off by default. A note sent with no account then waits in the database, `POST /feedback` answers `202` with `held: true`, and the widget says « Sent for review » with no pin. A member finds the notes in « To approve », a new entry of the views in the bar, and approves one (it goes to its place, as the visitor's own) or rejects it. A note waits 30 days at most.
- 0dcf745: A site can keep every version of its notes: « Keep every version », the third line of the card « Safeguards » in its tab « Access », on by default. An edit of the text of a note keeps the text of before, and a deletion keeps the note as it was, with who did it and when. The members of the workspace read them in a section « History » of the panel of the note; a guest reads none. The widget tells the author, in the form of an edit, that the team keeps the text of before (`versionsKept` of a read). A note keeps 50 versions at most, and they go with the note.
- 2a54654: `notes` takes five more functions, each optional: `reply(id, { text, author? })`, `check(id, { verdict, text?, author? })`, `edit(id, text)`, `withdraw(id)` and `attach(file)`. The widget offers the field to reply, « Looks fixed » / « Still wrong », « Edit the note », « Withdraw the note » and the files of the composer only where `notes` has the function. `write` gets the ids `attach` gave as its second argument, `{ attachments }`. `read` may give back `mine`, `replies` and `attachments` with each note: `mine` is what offers the edit, the withdrawal and the verdict to the author. `localNotes()` takes them all: every note it keeps is the reader's, and of a file it keeps the name only. A widget with `notes` never offers to move a note.
- 5925594: A member changes the status of a note from the head of its thread: the chip of the status becomes a button with a chevron, and its menu lists the five stages, the one of the note checked. The widget sends the built-in status of the stage through `POST /feedback/<id>/status`, the route the console and the extension already had, with its rights: the person who left the note or a role that manages the sites, with a session. The read says `canSetStatus` on each note the reader may move, after the cache. A visitor, a guest with no right on the note and a note of a tracker keep the status read only. The extension relays `/feedback/<id>/status` with the session.
- cdc234d: A site limits the notes a visitor with no account leaves in an hour: the line « Notes per visitor » of the new card « Safeguards » in its tab « Access », « No limit », 5, 10, 20 or 50, and 10 by default. The worker counts them by the key of the browser and by the address, on the site, before anything is written, and answers `429 visitor-limit` over it. The widget then says « Send it again later » and keeps the text. A member and a page that signs its reporter are not counted. The migration gives 10 to every site, those of before included.

### Patch Changes

- 57a3835: A key typed in a field of the widget no longer reaches the shortcuts of the page. On the console, each « c » of a note opened « New task » and was missing from the note. The keys of the widget (Escape, Cmd or Ctrl and Enter, a paste, an IME) work as before, and while a field of the page has focus, the capture mode and the thread leave its keys to it.
- Updated dependencies [0dcf745]
- Updated dependencies [5925594]
  - @fruitback/shared@0.9.0

## 0.8.0

### Minor Changes

- 4e3ad70: The widget takes `actionColor` at `init`, and `setActionColor` later: the colour of « Send » in the composer, refused under 4.5:1 with white text. The extension has an « Appearance » page where a person chooses the colour of the note button (Fruitback red, Deep red, Orange, Ink, or their own): it paints « Leave a note » in the popup and the side panel, and « Send » of the widget it mounts, for that person only.
- 57bb8e5: The thread of a note says « An agent is working on this note » when a call of the site's trigger started a Claude Code routine session for it. A member of the team who can see the tracker also gets « Open the session », a link to that session. Guests, reviewers and visitors see the line without the link. The read gives `agent: {}`, or `agent: { url }` to a member of the team. Only `https` addresses are given.
- 21aa779: The person who left a note gets one e-mail when the team marks it done: a member at the address of their account, a visitor at the address they gave just after the note, once per browser. The worker keeps that address for one message, 90 days at most (table `done_notices`, migration `0042`), and takes it on `POST /feedback/<note>/notify` with the token of the note. The icon of the extension shows, for the site of the tab, how many notes of the reviewer are done and waiting for their check.
- 4e2f1df: The author of a note can edit its text while the note is open: new, to do or in progress, and no longer only while it is new. On a note sent to Linear, Fruitback leaves the description of the issue as it is and posts a comment « Edited the note » with the new text, and the thread shows that new text. An address receives a new `note.edited` event, which carries identifiers only, and the console lists it among the deliveries. Notes sent to GitHub, and sites whose replies are hidden, still take no edit.
- 1a60ff2: A note whose Linear place is gone now says why, everywhere. When Linear refuses a note with `INPUT_ERROR` and no longer finds the team or the project of the site, the worker writes Linear's reason to its log, keeps the state on the destination of the site, and answers `502 destination-unavailable` with a link to help. The console shows « Needs attention » on that destination and on the card of the site, with what to change. The widget keeps the text and says the team cannot receive the note: a member gets a link to the site in the console, anybody else a link to the guide « A note that did not go ». A widget of before still reads a `502` and keeps the note.
- 880d540: The author of an open note can move it to another element of the same page, from « ⋯ » in its thread. The widget asks for the new element, then the note moves there. On Linear, the issue keeps its description and gets a comment « Moved the note » that names the element, and the thread reads the note's new place from that comment. An address receives a new `note.moved` event, which carries identifiers only, and the console lists it with the other deliveries. Notes sent to GitHub cannot be moved.
- 3d4f2eb: On a phone, « Send » takes the whole width of the sheet, every target of the composer is 44 px, and the element stays in sight: the page scrolls it above the sheet, or the sheet stands on the top when the page cannot scroll that far. The lists say « 99+ » above 99 in a tab, a chip and a scope, and « To check » always exactly (`shortCount` of `@fruitback/shared`). A long host is cut at its start, in the list of the widget, the popup and the side panel, with the whole host in its tooltip. The widget reads a page ground on one canvas per document.
- f48ad10: The widget runs with no worker: `init({ notes })` hands each note to `write`, and draws the pins that `read` gives back. `localNotes()` keeps the notes in `localStorage`, for a demo, a test or a page with no server. With `notes`, `endpoint` and `clientId` are optional, and the widget offers no reply, no place, no address to ask and no file.
- c7d700b: The list of the notes has three tabs that follow the loop, in the widget and in the side panel of the extension: « To check », « Open » and « Done ». « To check » holds the notes of the reader that the team marked done and nobody confirmed; it replaces the block « Ready to check » above the tabs. The list opens on « To check » while a note waits there. In the widget, the search, the scope and the chips move behind « Search and options », the magnifier of the head, as in the side panel. `noteTab` and `firstTab` of `@fruitback/shared` sort a note into its tab.
- 132f13b: The widget reads the ground of the page when it mounts and at each capture. On a dark site, what floats over the page takes a white line at 16 % and a denser shadow, and the frame of an element a light halo. On a red site, where the red of Fruitback is under 3:1, the frame, its name, the tether of the composer and the edge of each drop take the ink of the widget, #18181b, with a white contour.
- 2dd49ea: A note in the list says the stage of Fruitback first and the tracker second, « In progress · Linear: In Review », after a round that fills as the note moves on: a dashed ring for New, an empty one for To do, half full for In progress, full with a tick for Done, with a cross for Closed (`createStageRing`). The filter of the list keeps its shape: All and the five stages, Closed too, in the widget and the side panel; the list of statuses that took the place of the chips beyond five statuses is gone, and the search finds the name of a status or the word of a tracker. `trackerOf`, `stageFirstLabel` and `TRACKER_NAMES` of `@fruitback/shared` name the tracker of an issue by its address.
- fbeaa0f: A visitor with no account sees « You · this browser » on the notes they left from this browser. At the first note, the widget makes a random key for the site and keeps it in the page's `localStorage`. It sends the key in the `X-Fruitback-Visitor` header, and the worker keeps only a SHA-256 digest of it with the note. A read that sends the same key gets `mine: true` on those notes. Another browser, a missing key, or a key of another shape gets nothing. The key is not a proof of identity, and it does not let a visitor edit or withdraw a note yet. Nothing changes for a member, and a widget mounted with an identity token or by the extension makes no key. Migration `0050_note_index_author_visitor` adds the column `note_index.author_visitor`. Every row of before keeps an empty value.
- a1877fe: A visitor with no account deletes their own note while it is open, from the same browser, after a confirmation. The widget menu reads « Delete the note », in red. The question is « Delete your note? », and it says that the pin goes away for everyone and that the issue in the tracker is closed as withdrawn. `POST /feedback/<id>/withdraw` takes the key of the browser on a site that takes notes from anybody, with the checks of a member's withdrawal. Nothing is deleted in the store: the note is closed with a reply, Linear cancels the issue, and an address gets `note.withdrawn`. The index marks the row (`note_index.removed_at`, migration `0051_note_index_removed_at`), and a read of the page no longer shows that note to anybody. The team keeps the note, closed, in its tracker and in the console. A member's withdrawal is unchanged.
- 4b78560: A visitor with no account edits the text of their own note while it is open, from the same browser. `POST /feedback/<id>/text` takes the key of the browser instead of a session, on a site that takes notes from anybody. Every check of a member's edit still applies: the author kept in the index, the open stage read again under the lock, and one place. The reply names the visitor « not verified », and a tracker gets the new text in that reply. Another browser, a missing key and a closed note are refused. An edit counts with the visitor's replies, 5 a minute. In the widget, the visitor's menu reads « Edit the text » with no « Move the note ». The note says « You can edit it until a member picks it up. », and the field says « Edited text is sent to Linear too ».
- 66f4f52: The thread of an open note has a menu « ⋯ » for its author: « Edit the note », where the server offers
  the edit, and « Copy link to the note », which copies the link that opens the note on its page. A copy
  the browser refuses shows the link, to copy by hand.
- 5f5e51e: « Keep for later » becomes a batch under « Send » (FRU-608). With notes waiting, the main button
  says « Send all 3 », the icon « Add to batch » shows the count, and a menu beside « Send » offers
  « Send only this note ». The batch goes in as few requests as the worker allows, says « Sending 2 of
  3… », and ends on a receipt with the link of each ticket; a partial send keeps the note that did not
  go, with « Copy text » and « Send again ». A batch now starts an agent once, with every note in
  `notes`.
- 4ddc561: The composer is lighter (FRU-607). It opens beside the element, on the side with room, joined to it
  by a line; above it only as a last resort. The field holds the note, its files, two icons to add a
  capture or a file, and the signature as an avatar: the initials, or « Guest » in dashes, and a click
  opens the name. The head writes what the element says, and the selector only with « Show CSS
  selectors »: `selectorInHead` is `with-selectors` by default, `always` keeps the old head. Where the
  note goes shows as the tile of the tool and the most precise name, the whole path in the tooltip.
- 5aa014f: The files of a note live in its field (FRU-609). In the extension, a capture of the element joins
  the note at the open, as a thumbnail with the element framed; a cross removes it, a click opens it
  whole, and it leaves only with the note. Each file says its state, and a file too large says its size
  and the limit. « Send » waits for the files on their way and says so. The area of a capture shows its
  size and can take the visible page whole. A reader who must sign in first sees « Sign in to send »,
  and the note stays until they do. « Name » and « Remember me in this browser » replace the old labels.
  The extension asks a capture once more, after a second, when the browser refused it for its rate.
- 9159f49: The settings of the widget end with « Hide Fruitback on this page » for a host that gives `hide` to `init`. The extension gives it: the click hides the widget on that origin, as the popup does, and only in a gesture of the person.
- aba9530: The thread of a note follows the mock-up of 2026-11-25: 360 px wide with a corner of 10 px, a head of 40 px with the status in a chip (the round of its stage and its word), the ticket with the mark of its tracker and the sign of a new tab, the menu and the cross. The note and its replies are one conversation, each with the initial of who wrote, the name, the age and the text. « Technical details » folds the selector, the component and the file under the conversation: the option `showSelectors` opens it. The field to reply is one line with « Send » inside it. The dock shows the counts of the page by status between the list and the settings.
- 023a84b: The thread of a pin says who marked a note done (« Marc Petit marked it done »), and asks its author « Does it look right to you? », with « Looks fixed » and « Still wrong ». « Still wrong » opens a field to say what is missing, sent with the verdict. The worker decides who may: the thread asks the reader the read calls the author (`mine`). The replies of a verdict read in the words of the reader.
- d96c822: The author of an open note can withdraw it from « ⋯ » in its thread. The thread asks first, then closes the note, and nothing is deleted. A reply under the note says who withdrew it. On Linear, the issue gets the same reply as a comment and moves to the team's first canceled state. An address receives a new `note.withdrawn` event, which carries identifiers only, and the console lists it with the other deliveries. The read gives `withdrawable: true` for the note the reader may withdraw. Notes sent to GitHub cannot be withdrawn.

### Patch Changes

- 6535b23: A note opened before the first read of the page answered now joins the capture of its element when that read says the note takes files. Before, the note went without it.
- 26f4598: **TypeScript no longer catches a missing `endpoint` or `clientId`.** Both are optional in `FruitbackOptions` now, because `notes` takes the place of a worker. If you call `init` with neither `notes` nor both of them, the compiler accepts the call, and `init` throws a named error when the page loads. Check your `init` call when you update.
- 9ff903d: The field of a reply is the same everywhere: two lines, Enter sends, Shift+Enter goes to the next line, and the text is kept. The thread of the widget opens its reply on two lines; the side panel of the extension sends on Enter, and keeps what was typed in a reply after « Cancel », a closed row or another tab, until the reply goes.
- 52fa16d: A pin is drawn over the dock, the settings and the list of the page, so a note on an element in the corner of the dock stays visible. The thread, its tether and the preview of a pin stay over every pin; the composer and the capture of an area stay over everything.
- 04b7b96: `@fruitback/shared` exports `RESOLVED_STAGES`, the stages done and closed. The widget's `RESOLVED_STAGES` is now that same list, re-exported, and stays a public export. The console reads it for its « Unresolved » filter of the status.
- d6b3084: The buttons and the tags of the widget are no longer pills: « Send », « Cancel », « Send reply », « Leave a note » in the list, the chips of the statuses and « Guest » take corners in proportion to their height. « DEV-001 → » and « Choose another element » get back the corner that their transparent border took.

  The widget moves faster: 150 ms for a fade or a press, 240 ms for the composer and the drop of a pin. Every button eases its colours and gives way a little under a press, and the menus « Attachments » and « More » fade in. With `prefers-reduced-motion`, none of it moves.

- 73281a2: The script of the widget is 66 kB lighter gzipped (198 kB to 132 kB). The note contract imported zod as one named value, so the bundle kept all of zod: about 50 locales of error messages and the JSON Schema converters, which the widget never uses. It now imports zod as a namespace, which the bundler can trim. The schemas, and the English messages of zod, are the same.
- Updated dependencies [57bb8e5]
- Updated dependencies [3d4f2eb]
- Updated dependencies [c7d700b]
- Updated dependencies [2dd49ea]
- Updated dependencies [687ed1f]
- Updated dependencies [01b7b9b]
- Updated dependencies [04b7b96]
- Updated dependencies [d96c822]
- Updated dependencies [73281a2]
  - @fruitback/shared@0.8.0

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
