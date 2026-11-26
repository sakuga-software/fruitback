# @fruitback/worker

## 0.8.0

### Minor Changes

- 57bb8e5: The thread of a note says « An agent is working on this note » when a call of the site's trigger started a Claude Code routine session for it. A member of the team who can see the tracker also gets « Open the session », a link to that session. Guests, reviewers and visitors see the line without the link. The read gives `agent: {}`, or `agent: { url }` to a member of the team. Only `https` addresses are given.
- 7751a1f: A workspace can connect Asana: by consent at Asana on a server whose operator sets `FRUITBACK_ASANA_OAUTH`, or by a personal access token anywhere. Each note becomes a task of the project a site chooses, with its files attached, and its pin takes the stage of its completion or of its section. Fruitback keeps the tokens encrypted, revokes a consent when its connector goes, and says « Needs attention » when Asana refuses it.
- 950e993: The trigger of a site can start a Claude Code routine of the team. « Connectors » takes the Fire URL and the token of the routine: Fruitback keeps the token encrypted, sends it to api.anthropic.com only, and never shows it again. A call carries identifiers only, and notes sent together start one session. The panel of the routine shows « Session started » with the link of each session. A refused token stops the call at once, and the routine needs attention.
- 84e078e: A workspace can connect ClickUp: by consent at ClickUp on a server whose operator sets `FRUITBACK_CLICKUP_OAUTH`, or by a personal token anywhere. Each note becomes a task of the list a site chooses, with its files attached, and its pin takes the stage of the status of the task. Fruitback keeps the token encrypted, and says « Needs attention » when ClickUp refuses it.
- 21aa779: The person who left a note gets one e-mail when the team marks it done: a member at the address of their account, a visitor at the address they gave just after the note, once per browser. The worker keeps that address for one message, 90 days at most (table `done_notices`, migration `0042`), and takes it on `POST /feedback/<note>/notify` with the token of the note. The icon of the extension shows, for the site of the tab, how many notes of the reviewer are done and waiting for their check.
- 4e2f1df: The author of a note can edit its text while the note is open: new, to do or in progress, and no longer only while it is new. On a note sent to Linear, Fruitback leaves the description of the issue as it is and posts a comment « Edited the note » with the new text, and the thread shows that new text. An address receives a new `note.edited` event, which carries identifiers only, and the console lists it among the deliveries. Notes sent to GitHub, and sites whose replies are hidden, still take no edit.
- e171e51: A workspace can connect GitLab, on gitlab.com or on a self-managed GitLab that the internet reaches, by a project access token (Reporter, scope `api`). Each note becomes an issue of the project a site chooses, with its labels and its files, and its pin takes the stage of the state of the issue. The token is kept encrypted, every call to a self-managed GitLab is guarded against an internal address, and the connector says « Needs attention » when GitLab refuses the token or a project.
- 1529f61: A workspace can connect Jira Cloud, by consent at Atlassian (OAuth 2.0), on a server whose operator sets `FRUITBACK_JIRA_OAUTH`. Each note becomes an issue of the project a site chooses, with its files attached, and its pin takes the stage of the status of the issue. Fruitback takes no API token of Jira, keeps the token of the consent encrypted, and says « Needs attention » when Atlassian refuses it or ends it.
- 1a60ff2: A note whose Linear place is gone now says why, everywhere. When Linear refuses a note with `INPUT_ERROR` and no longer finds the team or the project of the site, the worker writes Linear's reason to its log, keeps the state on the destination of the site, and answers `502 destination-unavailable` with a link to help. The console shows « Needs attention » on that destination and on the card of the site, with what to change. The widget keeps the text and says the team cannot receive the note: a member gets a link to the site in the console, anybody else a link to the guide « A note that did not go ». A widget of before still reads a `502` and keeps the note.
- e526c7d: `/mcp` writes a task with no page and no pin. The new `create_task`, for a key that writes, takes a
  title and, if you like, a text, a status, an assignee, a priority, a due day and labels, as « New
  task » of the console does. It refuses an argument it does not take, a site that is not of the key,
  and a status, a member or a label that is not of the site or of the workspace, and then writes
  nothing. Its answer says what it wrote. `update_task` and `set_note_status` now change such a task
  too. A task an agent writes starts no agent. In the console, the log of a key says « Wrote a task ».
- 01b7b9b: `/mcp` reads and changes the tasks Fruitback keeps. `list_notes` and `get_note` give the fields of a
  task, and `list_notes` filters by assignee, priority, label and due day, as the console does. The new
  `task_choices` gives the ids of the labels and of the members, and `update_task` changes the status,
  the assignee, the priority, the due day and the labels, for a key that writes. On a worker that keeps
  no task, no tool of a task is listed. In the console, the right of a key that writes is « Read, reply
  and change the tasks », and its log says « Changed the fields of a task ».
- 880d540: The author of an open note can move it to another element of the same page, from « ⋯ » in its thread. The widget asks for the new element, then the note moves there. On Linear, the issue keeps its description and gets a comment « Moved the note » that names the element, and the thread reads the note's new place from that comment. An address receives a new `note.moved` event, which carries identifiers only, and the console lists it with the other deliveries. Notes sent to GitHub cannot be moved.
- f7d4236: The administrator of a self-hosted instance reads a banner when a newer release is out, and can dismiss it. The worker answers it on `GET /console/admin/release`. The upgrade guide says what a pull takes for each kind of image tag.
- 6cfe11e: The page of a site has a tab « Access »: who reads the notes and who leaves them, as four levels (Closed, Read only, Contribute, and Collaborate to come), and a table of what a visitor may do. A visitor's right to change the text of their own note and to take it back is a setting of each site, `never` or `while-open`, kept by the worker in two new columns. « Who can leave a note » now decides on a site that everyone reads too: « Read only » is read by anyone and written by its members. The migration gives every site that everyone read « Anyone on the page », and every site of before `never` for both rights, so no site changes.
- 25734d3: A workspace can post its notes in a Slack channel, by an Incoming Webhook. Each verified note, or each note if the connector says so, is posted with its link, its element and its capture, while the notes stay in Fruitback. The webhook is kept encrypted, and the panel of the connector lists the notes that did not reach Slack.
- d6cae1c: Several tasks that Fruitback keeps can be selected at once, by their boxes, with Shift and a click for a range, or with Cmd or Ctrl and A for the page. A bar under the list changes their status, assignee, priority, labels or due day, archives them or deletes them, in one call that changes all of them or none; the menu of a selected task acts on the whole selection.
- 687ed1f: A task is copied as its link, its ID or Markdown for an agent, from its menu, its panel, Cmd/Ctrl+Shift+C and Cmd/Ctrl+Shift+. The tool `notes_as_text` of a whole site ends with its tasks written by hand.
- 01b7b9b: A task is written by hand in the console, with a title and, if you like, a text, a status and its fields. It has no page and no pin.
- 2e93317: An address that receives the notes of a site is told of each change of their tasks: `note.status_changed` with the status before and after, `note.replied` with the id of the reply, and `note.updated` with the names of the fields that changed (assignee, priority, labels, day). Each holds ids and names only, is signed and tried again as a note, and a change that changes nothing sends nothing. A note sent to an address now takes replies, kept in Fruitback. The console names these events in the deliveries that did not arrive.
- 36dbf5c: A task that Fruitback keeps has an assignee, a priority, a day and labels. The list and the board of the notes show them.
- 9390cc2: The list of the notes filters the tasks Fruitback keeps by assignee, priority, label and due day.
- 5a3f29a: A task that Fruitback keeps can be put in its place in its column of the board, archived, brought back and deleted.
- 4f057d0: A note opens in a panel over the list: its text, its page, its element, its replies, and the fields of its task.
- 8245be6: `FRUITBACK_TASKS=off` turns off the tasks of a server: a site needs a destination, and the notes the server kept before are read-only. `on` is the default.
- fbeaa0f: A visitor with no account sees « You · this browser » on the notes they left from this browser. At the first note, the widget makes a random key for the site and keeps it in the page's `localStorage`. It sends the key in the `X-Fruitback-Visitor` header, and the worker keeps only a SHA-256 digest of it with the note. A read that sends the same key gets `mine: true` on those notes. Another browser, a missing key, or a key of another shape gets nothing. The key is not a proof of identity, and it does not let a visitor edit or withdraw a note yet. Nothing changes for a member, and a widget mounted with an identity token or by the extension makes no key. Migration `0050_note_index_author_visitor` adds the column `note_index.author_visitor`. Every row of before keeps an empty value.
- a1877fe: A visitor with no account deletes their own note while it is open, from the same browser, after a confirmation. The widget menu reads « Delete the note », in red. The question is « Delete your note? », and it says that the pin goes away for everyone and that the issue in the tracker is closed as withdrawn. `POST /feedback/<id>/withdraw` takes the key of the browser on a site that takes notes from anybody, with the checks of a member's withdrawal. Nothing is deleted in the store: the note is closed with a reply, Linear cancels the issue, and an address gets `note.withdrawn`. The index marks the row (`note_index.removed_at`, migration `0051_note_index_removed_at`), and a read of the page no longer shows that note to anybody. The team keeps the note, closed, in its tracker and in the console. A member's withdrawal is unchanged.
- 4b78560: A visitor with no account edits the text of their own note while it is open, from the same browser. `POST /feedback/<id>/text` takes the key of the browser instead of a session, on a site that takes notes from anybody. Every check of a member's edit still applies: the author kept in the index, the open stage read again under the lock, and one place. The reply names the visitor « not verified », and a tracker gets the new text in that reply. Another browser, a missing key and a closed note are refused. An edit counts with the visitor's replies, 5 a minute. In the widget, the visitor's menu reads « Edit the text » with no « Move the note ». The note says « You can edit it until a member picks it up. », and the field says « Edited text is sent to Linear too ».
- 5f5e51e: « Keep for later » becomes a batch under « Send » (FRU-608). With notes waiting, the main button
  says « Send all 3 », the icon « Add to batch » shows the count, and a menu beside « Send » offers
  « Send only this note ». The batch goes in as few requests as the worker allows, says « Sending 2 of
  3… », and ends on a receipt with the link of each ticket; a partial send keeps the note that did not
  go, with « Copy text » and « Send again ». A batch now starts an agent once, with every note in
  `notes`.
- d96c822: The author of an open note can withdraw it from « ⋯ » in its thread. The thread asks first, then closes the note, and nothing is deleted. A reply under the note says who withdrew it. On Linear, the issue gets the same reply as a comment and moves to the team's first canceled state. An address receives a new `note.withdrawn` event, which carries identifiers only, and the console lists it with the other deliveries. The read gives `withdrawable: true` for the note the reader may withdraw. Notes sent to GitHub cannot be withdrawn.

### Patch Changes

- c40459d: Linear keeps one pair of tokens for each Linear workspace, and a new consent ends the pair of before. A Linear connected in a second Fruitback workspace therefore ended the first one. Now every Linear connector of the same Linear workspace shares the pair. A consent or a refresh brings them all back, and disconnecting one connector revokes the pair only when no other connector uses it.

  A connection that Linear ended is reconnected in place: « Reconnect Linear » in the panel of the connector keeps its sites, their places and its settings. A « Connect » for a Linear workspace that the workspace already holds brings the old connector back instead of making a second one. The extension says, under « Sent to », that the notes of the site do not reach a tracker that refuses the connection. For an owner or an admin, it opens that connector in the console.

- 2270f4b: An owner or an admin reconnects a Linear that Linear ended from the popup itself: « Reconnect Linear » under « Sent to » opens the consent at Linear in a new tab, and Linear brings the browser back to the panel of the connector in the console, with its sites and its settings. A worker that refuses, or a tracker other than Linear, still opens the connector in the console.
- 3fa0cf6: A task sent on to an address moves to the group of its new status in the list and the board of the console as soon as its status changes, as a task with no destination does. Before, it stayed in its old group until its page was read again.
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
