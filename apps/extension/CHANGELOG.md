# @fruitback/extension

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
