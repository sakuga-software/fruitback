# @fruitback/extension

## 0.9.0

### Minor Changes

- 51a12e5: Extension mode on a site of Fruitback Cloud that its members read: the popup says it in plain words and offers what fixes it. Signed out, « Only the members of this site see its notes and leave one here » with « Sign in to Fruitback ». Signed in as a member, « Turn on with my account » turns the site of the workspace on in place of the extension-mode rule, and the widget reads and writes with the account. Signed in with an account that is not a member, the popup says to ask the team of the site for an invitation. Extension mode stays available on the Cloud, and a server run by somebody else keeps its sentences.
- 5925594: A member changes the status of a note from the head of its thread: the chip of the status becomes a button with a chevron, and its menu lists the five stages, the one of the note checked. The widget sends the built-in status of the stage through `POST /feedback/<id>/status`, the route the console and the extension already had, with its rights: the person who left the note or a role that manages the sites, with a session. The read says `canSetStatus` on each note the reader may move, after the cache. A visitor, a guest with no right on the note and a note of a tracker keep the status read only. The extension relays `/feedback/<id>/status` with the session.
- 581d4f8: « To check » in the side panel lists the notes to check of the other pages of the site, the ones the badge counts, under « On other pages ». Each has « Looks fixed », « Still wrong » and « Open on its page », and its verdict goes from the panel. Before, the badge could count notes that no list showed. `GET /session/notes` takes `check=1`: the notes of the reader that wait for their verdict.

### Patch Changes

- cc03fa9: « Private mode » is now « Extension mode » (« mode extension » in French): the mode where the extension shows the widget on a site that embeds nothing. The popup and the options page offer « Extension · the extension shows the widget », the table of the sites says « Extension », and the messages of the popup, of the servers page and of « Who can leave a note » in the console use the new name. Team mode keeps its name. The stored value of a rule stays `private`, so a rule saved before and a rules file written by an older version work as before.
- deda90e: Extension mode on a site of Fruitback Cloud that its members read: when the session of the account has ended (expired, or signed out from the console), the side panel now says « Only the members of this site see its notes and leave one here. Sign in to Fruitback to review it as a member. », with « Open Fruitback », as the popup does. It said « your account is not one of them », as if the account were still signed in.
- 574c250: Extension mode on a site of Fruitback Cloud that its members read: the side panel now says what the popup says, in place of « The notes of this page could not be read ». Signed out, « Only the members of this site see its notes and leave one here. Sign in to Fruitback to review it as a member. », with « Open Fruitback », which opens the popup where « Sign in to Fruitback » is. Signed in as a member, it says to turn the site on with the account. Where the site takes no note from extension mode, the panel no longer offers « Leave a note ». A server run by somebody else keeps « could not be read ».
- Updated dependencies [87b59e4]
- Updated dependencies [0dcf745]
- Updated dependencies [2a54654]
- Updated dependencies [5925594]
- Updated dependencies [cdc234d]
- Updated dependencies [57a3835]
  - @fruitback/widget@0.9.0
  - @fruitback/shared@0.9.0

## 0.8.0

### Minor Changes

- 4e3ad70: The widget takes `actionColor` at `init`, and `setActionColor` later: the colour of « Send » in the composer, refused under 4.5:1 with white text. The extension has an « Appearance » page where a person chooses the colour of the note button (Fruitback red, Deep red, Orange, Ink, or their own): it paints « Leave a note » in the popup and the side panel, and « Send » of the widget it mounts, for that person only.
- 21aa779: The person who left a note gets one e-mail when the team marks it done: a member at the address of their account, a visitor at the address they gave just after the note, once per browser. The worker keeps that address for one message, 90 days at most (table `done_notices`, migration `0042`), and takes it on `POST /feedback/<note>/notify` with the token of the note. The icon of the extension shows, for the site of the tab, how many notes of the reviewer are done and waiting for their check.
- 2a48f4a: The popup of a site that is on follows the mock-up of 2026-11-25: a head of 48 px with the workspace (a menu of the workspaces of the account, each opening in the console), the site in a card with « On · Acme · 4 open notes » and a switch, « Sent to » in a field of 32 px whose chevron opens « Where notes go », « Leave a note » of 40 px with its keys inside, then « On this page »: the notes of the page, one line each with their status and their age, read from the widget of the tab. A click on a note opens it on the page. « Open sidebar » opens the side panel, and the foot holds « Console », the guide and the menu of the site.
- 880d540: The author of an open note can move it to another element of the same page, from « ⋯ » in its thread. The widget asks for the new element, then the note moves there. On Linear, the issue keeps its description and gets a comment « Moved the note » that names the element, and the thread reads the note's new place from that comment. An address receives a new `note.moved` event, which carries identifiers only, and the console lists it with the other deliveries. Notes sent to GitHub cannot be moved.
- 3d4f2eb: On a phone, « Send » takes the whole width of the sheet, every target of the composer is 44 px, and the element stays in sight: the page scrolls it above the sheet, or the sheet stands on the top when the page cannot scroll that far. The lists say « 99+ » above 99 in a tab, a chip and a scope, and « To check » always exactly (`shortCount` of `@fruitback/shared`). A long host is cut at its start, in the list of the widget, the popup and the side panel, with the whole host in its tooltip. The widget reads a page ground on one canvas per document.
- c7d700b: The list of the notes has three tabs that follow the loop, in the widget and in the side panel of the extension: « To check », « Open » and « Done ». « To check » holds the notes of the reader that the team marked done and nobody confirmed; it replaces the block « Ready to check » above the tabs. The list opens on « To check » while a note waits there. In the widget, the search, the scope and the chips move behind « Search and options », the magnifier of the head, as in the side panel. `noteTab` and `firstTab` of `@fruitback/shared` sort a note into its tab.
- 9ff903d: The field of a reply is the same everywhere: two lines, Enter sends, Shift+Enter goes to the next line, and the text is kept. The thread of the widget opens its reply on two lines; the side panel of the extension sends on Enter, and keeps what was typed in a reply after « Cancel », a closed row or another tab, until the reply goes.
- 3b77bb2: The page of the extension has one page for each setting: Sites, Servers and sessions, Share rules and Preferences. The address chooses the page, Back and Forward go between them, and what you typed on a page is still there when you come back. On a narrow window the menu is a bar above the page.
- 72cc4ce: « Where notes go » is a screen of the popup: one card per place, the lists of the chosen one, and Save. After a save, a notice says where new notes go. A member who may not change the place sees it locked, with a message to copy for an admin.
- 614009d: « Show Fruitback on this page » is now « Hide Fruitback on this page », an icon button beside the side panel in the popup. The popup has one switch, the one of the site. Hidden, « Leave a note » and the side panel stay in place, turned off.
- bfabab5: The popup of a site that is on is a launcher: « Leave a note » first, « Sent to » on the line above it with a pencil to change it, the side panel with the open notes and the fixes to check under it, and a menu « ⋯ » that holds « Hide the widget on this site », « Stop reviewing this site », « Change where notes go » and « All settings for this site ». The switch of the site is gone, and the popup is as high as what it holds.
- 327beba: The popup turns a site on in one click: « Leave notes on this site? » sums up where the notes go and who sees them, and « Change before turning on » opens the lists. A site that only an admin can add gives a message to copy for that admin. A sign-in that did not finish says its problem as the title, then « Sign in again ».
- 2dd49ea: A note in the list says the stage of Fruitback first and the tracker second, « In progress · Linear: In Review », after a round that fills as the note moves on: a dashed ring for New, an empty one for To do, half full for In progress, full with a tick for Done, with a cross for Closed (`createStageRing`). The filter of the list keeps its shape: All and the five stages, Closed too, in the widget and the side panel; the list of statuses that took the place of the chips beyond five statuses is gone, and the search finds the name of a status or the word of a tracker. `trackerOf`, `stageFirstLabel` and `TRACKER_NAMES` of `@fruitback/shared` name the tracker of an issue by its address.
- 9159f49: The settings of the widget end with « Hide Fruitback on this page » for a host that gives `hide` to `init`. The extension gives it: the click hides the widget on that origin, as the popup does, and only in a gesture of the person.
- d96c822: The author of an open note can withdraw it from « ⋯ » in its thread. The thread asks first, then closes the note, and nothing is deleted. A reply under the note says who withdrew it. On Linear, the issue gets the same reply as a comment and moves to the team's first canceled state. An address receives a new `note.withdrawn` event, which carries identifiers only, and the console lists it with the other deliveries. The read gives `withdrawable: true` for the note the reader may withdraw. Notes sent to GitHub cannot be withdrawn.

### Patch Changes

- 6dda086: « Appearance »: when a colour of your own was stored and a ready colour chosen over it could not be saved, the colour of your own comes back in its field, with its contrast, instead of an empty field.
- f46cbb0: A capture refused for want of permission on its second try, after a refusal for its rate, now says « Click the Fruitback icon… » as on the first try, and no longer « The capture was not taken ».
- 6535b23: A note opened before the first read of the page answered now joins the capture of its element when that read says the note takes files. Before, the note went without it.
- 024cb76: The extension builds its stylesheets with Tailwind, on the shared theme of Fruitback: its tokens and their dark scheme move to `src/theme.css`, and the kit is written with `@apply`. Nothing changes on screen.
- 03e6ded: The sheet of the page of the extension (sites, servers, sharing, preferences, appearance) is written with Tailwind (`@apply`) on the theme of the extension. Nothing changes on screen.
- 5155fe3: The sheets of the side panel and of the welcome page, and the frame of the gallery, are written with Tailwind (`@apply`) on the theme of the extension. Nothing changes on screen.
- b2b2ed0: The sheet of the popup, which every page of the extension loads first, is written with Tailwind (`@apply`) on the theme of the extension. Nothing changes on screen.
- c40459d: Linear keeps one pair of tokens for each Linear workspace, and a new consent ends the pair of before. A Linear connected in a second Fruitback workspace therefore ended the first one. Now every Linear connector of the same Linear workspace shares the pair. A consent or a refresh brings them all back, and disconnecting one connector revokes the pair only when no other connector uses it.

  A connection that Linear ended is reconnected in place: « Reconnect Linear » in the panel of the connector keeps its sites, their places and its settings. A « Connect » for a Linear workspace that the workspace already holds brings the old connector back instead of making a second one. The extension says, under « Sent to », that the notes of the site do not reach a tracker that refuses the connection. For an owner or an admin, it opens that connector in the console.

- 2270f4b: An owner or an admin reconnects a Linear that Linear ended from the popup itself: « Reconnect Linear » under « Sent to » opens the consent at Linear in a new tab, and Linear brings the browser back to the panel of the connector in the console, with its sites and its settings. A worker that refuses, or a tracker other than Linear, still opens the connector in the console.
- 256666d: On Opera, a page of search results (Google included) keeps the extension off until the person allows it. When a site is on and nothing of the extension runs in the tab, the popup now names the setting to turn on: « Allow access to search page results », in `opera://extensions`. The guide says it too.
- 52fa16d: A pin is drawn over the dock, the settings and the list of the page, so a note on an element in the corner of the dock stays visible. The thread, its tether and the preview of a pin stay over every pin; the composer and the capture of an area stay over everything.
- 8764fe7: A reply of the side panel goes once: while it is on its way, the field of its note stays held, with « Send » disabled, even when the reader opens the reply of another note and comes back to it.
- 662db05: Safari: the background starts again. Safari answers `undefined` to `alarms.create`, where Chrome answers a promise, so the background stopped at its start and « Turn on » in the popup loaded forever. The Xcode project is made with Xcode 27.2 too, and the app asks for macOS 12.
- 5aa014f: The files of a note live in its field (FRU-609). In the extension, a capture of the element joins
  the note at the open, as a thumbnail with the element framed; a cross removes it, a click opens it
  whole, and it leaves only with the note. Each file says its state, and a file too large says its size
  and the limit. « Send » waits for the files on their way and says so. The area of a capture shows its
  size and can take the visible page whole. A reader who must sign in first sees « Sign in to send »,
  and the note stays until they do. « Name » and « Remember me in this browser » replace the old labels.
  The extension asks a capture once more, after a second, when the browser refused it for its rate.
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
- Updated dependencies [687ed1f]
- Updated dependencies [01b7b9b]
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
  - @fruitback/shared@0.8.0

## 0.7.0

### Minor Changes

- The extension, since 0.6.0:

  - On a page that declares `<meta name="fruitback" content="frames">`, the widget goes into the frames of the same origin, and none in the top frame: a note in Storybook is left on the story itself and filed under the address of its frame. A page of another origin that frames an enabled site gets no widget in that frame. A page that declares nothing keeps the widget in its top frame, as before.
  - Under a site that is on, the popup says where its notes go, with the mark of the provider (Linear, GitHub, REST API or Fruitback), and « Change » for a role that may.
  - An install that no store updates (a folder loaded by hand, a temporary add-on) says « Fruitback x.y.z is out » in the popup when a newer release exists and on the options page, with a link to the release.
  - Each state of the popup that blocks has a centred button to the guide.
  - On an http site, the popup says to add the site from the console, in place of « Fruitback did not answer ».
  - The screens follow the glossary: « Leave a note », « server », « Connect », « Connection code », « Sign out »; the manifest speaks French, and a failed call says the cause and what to do.
  - A refused token of the Cloud is renewed once, and the access to a worker that does not parse says the sign-in did not start, with the buttons enabled again.

### Patch Changes

- 09282fc: `@fruitback/widget` exports `RELATIVE_UNITS`, the units its relative dates count in, from a module of its own. The extension counts the ages of its side panel with them, and relays files with the widget's `base64OfBytes` and `bytesOfBase64` in place of its copies. Nothing it shows or sends changes.
- 86c5798: `@fruitback/shared` exports the messages between the console and the extension of the same browser: `EXTERNAL_VERSION`, `EXTERNAL_TYPES`, the types `ExternalAsk` and `ExternalAnswer`, the lists `EXTERNAL_CONNECT_STATES` and `EXTERNAL_REFUSALS`, and `parseExternalAnswer`. The console reads each answer of the extension through it in place of casts, and the extension answers with the same types. The messages themselves do not change.
- 792ee35: The popup asks the worker for the sites of its tab only (`GET /session/sites?origin=…`), and for the language of the account through the list of the worker's own origin: it no longer reads every site of every workspace, with their counts, at each open. The worker reads the workspaces of an account four at a time, and counts the notes only of a workspace that has a site of the tab. Without the parameter, the answer is the whole list, as before, for the extensions already installed.
- 9b7ed99: `@fruitback/shared` exports how a note is painted and named, and the core of the words of the console and the extension, written once: `STATUS_INK`, `paintOfStatus(color, textColor)`, `statusLabel(statusName, stateName, stageWord)`, `nearestLanguage(tag, languages, fallback)` and `fillSentence(sentence, values)`. The widget, the extension, the console and the worker use them in place of their own copies; what each draws and says does not change.
- Updated dependencies [46c608c]
- Updated dependencies [09282fc]
- Updated dependencies [86c5798]
- Updated dependencies [0255b8b]
- Updated dependencies [e0e3ad1]
- Updated dependencies [64a50c4]
- Updated dependencies [bf65df2]
- Updated dependencies [e3fea3b]
- Updated dependencies [51a498f]
- Updated dependencies [9b7ed99]
- Updated dependencies [88971e2]
  - @fruitback/widget@0.7.0
  - @fruitback/shared@0.7.0

## 0.6.0

### Minor Changes

- The screens of the extension, after a review of each of its states (gallery.fruitback.com):

  - The Google and GitHub buttons of the sign-in carry the mark of their provider, in the popup and on the welcome page.
  - The popup on a page of the browser says why nothing runs there, and what to do.
  - On a site that is on, « Leave feedback » sits at the bottom of the popup, with the side panel as a button of one icon beside it.
  - The welcome page shows an 18 s video of a first note, taken by a spec.
  - On a page Fruitback is not on, the side panel offers « Open Fruitback », which opens the popup.
  - The side panel has one side margin of 12 px, and a note holds one line in its lists.
  - Beyond five statuses, the filter of the side panel is a list that opens over the notes.
  - « Turn on » of the welcome page gives its scripts to the site it opens, after the load: a slow machine loaded it with no widget.
  - A failed read or pairing call no longer hides its fix.

### Patch Changes

- Updated dependencies [9bc7374]
  - @fruitback/widget@0.6.0
  - @fruitback/shared@0.6.0

## 0.5.0

### Minor Changes

- 91e55ad: On Fruitback Cloud, step 3 of the setup connects the extension of the same browser in place: one click, no `/connect` tab, no word to compare. The Chrome and Edge build declares `externally_connectable` for `https://app.fruitback.com` alone, and answers three strict messages from the top frame of a tab of that origin; no secret crosses that channel. Firefox, Safari and a self-hosted console keep the sign-in with the word.
- 3059d18: The widget the extension mounts on a site of a workspace offers « All pages » in its list: the notes of every page of the site, read with the session of the reviewer, as « Whole site » of the side panel.
- c14db05: `init` takes `openSidebar`: the button of the dock that shows every note asks the host for its side panel first, and opens the list of the page when the host cannot. The widget the extension mounts opens the side panel of the browser with it.

### Patch Changes

- 803f0b1: « All pages » of the widget the extension mounts gives the page an excerpt of 64 characters at most, whatever the worker sent.
- Updated dependencies [106f528]
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
  - @fruitback/shared@0.5.0
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
  - @fruitback/shared@0.4.0
