# @fruitback/worker

## 0.7.0

### Minor Changes

- 426aca8: The screen « Instance » of a self-hosted console says the version that the worker runs, and when a newer release is out, with the commands that update the instance. The worker asks GitHub for the last release once a day at most; `FRUITBACK_NO_UPDATE_CHECK=1` stops it.
- 4f6da7d: A Linear destination of a site carries the page of its team at Linear, `url` (`https://linear.app/<workspace>/team/<KEY>/all`), built by the worker from the keys Linear answers when the places of a site are written: the read of the places asks Linear for the `urlKey` of its workspace and the `key` of each team, in the same call as before. Migration 0041 adds the column `url` to `site_destinations`. A destination written before has none until its places are written again. On the Sites screen, the team under « Linear » is a link to that page, in a new tab.
- e0e3ad1: The tools of `/mcp` say « note », as the contract does: `list_feedback` is `list_notes`, `get_feedback` is `get_note`, `feedback_as_text` is `notes_as_text`, `reply_to_feedback` is `reply_to_note`, and `set_feedback_status` is `set_note_status`. The old names are gone, with no alias: an agent that is already configured must reload its tools. `notes_as_text` titles a page « Notes on {url} », as the widget does, and an issue with no text is titled « Note on <tag> — path ».

### Patch Changes

- 117e60d: A page on a site whose GitHub repository holds more than 100 Fruitback issues reads its notes with one search instead of listing up to 1,000 issues, and no longer loses the pins past the 1,000th. A read of GitHub gives up after 10 seconds instead of waiting forever.
- 1afc0f8: The page of a site says when GitHub lists only 1,000 of the repositories of an installation, and adds another one by its name. A read of the notes of a page keeps the search pages already read when GitHub refuses a later one for its rate.
- b6c91ad: The console reads one Linear place by its ids, a new connector only who its key belongs to, and the teams a page at a time with a search sent to Linear; the states of a connector are read past 250. At 300 teams of 60 projects, setting a destination takes 1 call in place of 306.
- d37e4ad: The list of the teams of a Linear asks for 20 projects a team, then the next ones team by team: Linear refused the query of 50 projects a team as too complex, and the console could not offer a team as a destination.
- 8c416ab: The read tools of `/mcp` read the pages of their notes 4 at a time, not one after the other, and answer the same. `forget` of the PostgreSQL store leaves out in SQL the rows that cannot be the notes asked for, and reads and deletes the rows 500 at a time.
- 9e5c5d8: The notes of a workspace and the notes of the instance count their filter once: « Next » and « Previous » keep the counts of the first page, and the worker reads the page alone (`counts=none`). The notes of the whole instance are read from a new index, `note_index_by_instance_date` (migration 0040): a page took 31 ms on 190,000 notes, it takes 0.08 ms.
- 792ee35: The popup asks the worker for the sites of its tab only (`GET /session/sites?origin=…`), and for the language of the account through the list of the worker's own origin: it no longer reads every site of every workspace, with their counts, at each open. The worker reads the workspaces of an account four at a time, and counts the notes only of a workspace that has a site of the tab. Without the parameter, the answer is the whole list, as before, for the extensions already installed.
- 9b7ed99: `@fruitback/shared` exports how a note is painted and named, and the core of the words of the console and the extension, written once: `STATUS_INK`, `paintOfStatus(color, textColor)`, `statusLabel(statusName, stateName, stageWord)`, `nearestLanguage(tag, languages, fallback)` and `fillSentence(sentence, values)`. The widget, the extension, the console and the worker use them in place of their own copies; what each draws and says does not change.
- 77a22d1: The console reads one site by its id (`GET …/sites/<id>`), one page of the sites with their total (`GET …/sites?limit=&offset=&q=`), and a light list to choose a site from (`GET …/sites/choices`), and the counts of the notes are read for the sites of the answer only.
- Updated dependencies [86c5798]
- Updated dependencies [e0e3ad1]
- Updated dependencies [e3fea3b]
- Updated dependencies [9b7ed99]
  - @fruitback/shared@0.7.0

## 0.6.0

### Patch Changes

- c4b647d: A tool of `/mcp` whose site the accounts do not read answers an error of the tool (`isError: true`) in place of a `502` for the whole request.
- 7f7edfc: A request reads the one site it names, and asks whether a site has the origin of its page, in place of reading every site of the instance: at 10,500 sites a request of the widget or the console takes 2 to 6 ms in place of 23 to 27. With the database down, a route that reads no site answers `503 limiter-unavailable` where it answered `502 store-unavailable`.
- a8b4b72: Migration `0039_sites_by_origin`: an index on the origin of the sites, so that the worker can find the site of a request by its origin without reading every site.
- @fruitback/shared@0.6.0

## 0.5.0

### Minor Changes

- 784f098: The worker keeps when each agent key last opened a request of `/mcp`, to the minute, and the list of the keys in the console API answers it as `lastUsedAt` (`null` for a key nobody used).
- 106f528: A reply can say `by: 'agent'`: an AI agent wrote it through `/mcp`, with an agent key of the workspace. The field is optional, and a widget that does not read it shows the name of the reply alone. The worker gives an agent key with the right `write` two tools, `reply_to_feedback` and `set_feedback_status`, limits each key to 30 writes a minute, and keeps a log of the writes of each key, which the owner and the admins read in the console API.
- ed49f59: A site can start an agent of the team when a note arrives: off by default, an owner or an admin turns it on in the page of the site. It calls an address of the workspace that receives (the REST connector), signed and tried again, when a note of a known person arrives or when a person of the team moves a note to To do. The call, `agent.requested`, carries the ids of the note, never its text; the agent reads the note through `/mcp` with its key.
- 5e1e3a0: The worker serves `POST /mcp`, a remote MCP server for an AI agent with an agent key of a workspace: `list_feedback`, `get_feedback` and `feedback_as_text` read the notes of the sites of the key, with their whole content. `@fruitback/shared` exports `feedbackText`, the plain text of the notes of a page that « Copy as text » writes, with the words given by the caller. `feedbackAsText` of the widget answers the same text as before.
- 667e2fe: A client that connects from a page, as a connector of claude.ai, gets a token for `/mcp` by OAuth 2.1: discovery by `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, open registration of clients, PKCE with S256, a person who approves in the console, an access token of one hour and a refresh token spent once. A connection is an agent key with no secret, listed and revoked with the others. Where OAuth is on (accounts, `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL`), `/mcp` answers `401` with `WWW-Authenticate` in place of `404` to a request it refuses. Migration `0038_oauth_connections`.

### Patch Changes

- Updated dependencies [106f528]
- Updated dependencies [ec76366]
- Updated dependencies [5e1e3a0]
  - @fruitback/shared@0.5.0

## 0.4.0

### Minor Changes

- 9133f0b: `node server.mjs rewrite-notes` is removed, with the only reader of the notes written before 0.4.0 (FRU-449). A worker of before 0.4.0 upgrades to 0.4.0 first and runs `rewrite-notes` there, then takes a later version: `docs/self-hosting/upgrade.md`.
- 504d911: **Breaking: a note is `fruitback.note`, version 3, and the word « seed » is gone (FRU-378).**

  - `@fruitback/shared` exports `Note`, `noteSchema`, `createNote`, `parseNote`, `parseNoteFromDescription`, `buildNoteBlock`, `NOTE_KIND`, `NOTE_VERSION`, `NOTE_STAGES` and the other `note` names, and `@fruitback/shared/note.fixture`. The names of 0.3.0 are removed: `Seed`, `SeedIssue`, `seedSchema`, `createSeed`, `parseSeed`, `parseSeedFromDescription`, `SEED_KIND`, `SEED_VERSION`, `@fruitback/shared/seed.fixture` and the other `seed` names.
  - A note is written and read as `{ "kind": "fruitback.note", "v": 3, …, "text": … }`: the words of the reporter are in `text`. `parseNote` reads that kind and version only; a payload of `fruitback.seed` reads as `not-found`. A read answers each issue with its note under `note`.
  - The worker answers `note` only: in each issue of `GET /feedback`, in each row of `GET /session/notes`, and in the REST delivery, whose `version` is now 2. A refused note is `invalid-note`. The commands take `forget --note` and `migrate-to-postgres --notes`.
  - `node server.mjs rewrite-notes [--dry-run]` rewrites once the notes written before 0.4.0, in the issues of Linear and GitHub, in the database and in the queue of deliveries. Run it right after the upgrade: `docs/self-hosting/upgrade.md`.
  - The widget keeps the notes for later under a new key of `sessionStorage`: the drafts kept by 0.3.0 are left.
  - The extension 0.3.0 does not read the notes of a 0.4.0 worker, and a widget 0.3.0 can neither send a note to it (`invalid-note`) nor draw its pins: update the worker, the widget and the extension together.

### Patch Changes

- Updated dependencies [504d911]
- Updated dependencies [54fc764]
  - @fruitback/shared@0.4.0
