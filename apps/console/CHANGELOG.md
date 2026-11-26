# @fruitback/console

## 0.8.0

### Minor Changes

- 7751a1f: A workspace can connect Asana: by consent at Asana on a server whose operator sets `FRUITBACK_ASANA_OAUTH`, or by a personal access token anywhere. Each note becomes a task of the project a site chooses, with its files attached, and its pin takes the stage of its completion or of its section. Fruitback keeps the tokens encrypted, revokes a consent when its connector goes, and says « Needs attention » when Asana refuses it.
- 950e993: The trigger of a site can start a Claude Code routine of the team. « Connectors » takes the Fire URL and the token of the routine: Fruitback keeps the token encrypted, sends it to api.anthropic.com only, and never shows it again. A call carries identifiers only, and notes sent together start one session. The panel of the routine shows « Session started » with the link of each session. A refused token stops the call at once, and the routine needs attention.
- 84e078e: A workspace can connect ClickUp: by consent at ClickUp on a server whose operator sets `FRUITBACK_CLICKUP_OAUTH`, or by a personal token anywhere. Each note becomes a task of the list a site chooses, with its files attached, and its pin takes the stage of the status of the task. Fruitback keeps the token encrypted, and says « Needs attention » when ClickUp refuses it.
- ffa02ad: Settings › Appearance: each person picks the look of their console. Five themes (Slate, the default, Snow, Zinc, Midnight and Graphite), the mode (Light, Dark or System), the tint of the sidebar, the accent, the density of the rows (32, 36 or 40 px), the radius (0, 4, 6 or 8 px) and the size of the text (12, 13 or 14 px), with « Reset ». A choice shows at once and stays in this browser, with no flash of the default theme at the next visit. Every theme, tint and accent keeps the contrasts of WCAG AA.
- 4af3cce: The console has a compact bar in place of the dark rail: 232 px on the slate of the sidebar, the workspace and a search of the notes at its top, the sections Notes, Sites, Connectors, Members and Settings in 28 px entries, and a fixed foot with « What's new » (the releases, with a dot until this version is seen), the extension (a green dot and the browser when it is connected), « Help and docs », and the person, whose menu opens « My account » and signs out. « My account » leaves the list of the sections. Under 1024 px the bar is folded above the screen, and « Menu » unfolds it. The administration of the instance has the same bar.
- d621101: The Connectors screen has a table of the connectors and a catalogue with the logo of each tracker. A row says the connector, its account, the sites that use it and its health: « N notes not delivered » in red for an address, a routine or Slack whose sends wait, with « Retry » to send them again; « Healthy » when none waits; « Needs attention » when the tracker refuses the connector or a place of a site; « Connected » for a tracker, whose deliveries the worker does not report yet. The red count of « Connectors » in the bar follows the sends that wait. The catalogue lists Linear, Jira, GitHub, GitLab, Asana, ClickUp, Trello, Notion, Slack, Webhook, the REST API and a Claude Code routine as tiles of 64 px, with a search and the groups Trackers, Agents and Developers; each tile says in one line what a note becomes there, and « Connected », « Connect », « Soon » or « Not set up ». The logos are SVG files that the console serves itself. The settings of a connector open in a dialog, in place of the accordion under its row, and « New connector » leads to the search of the catalogue.
- 9f8eba3: The page « General » of the settings of a workspace is drawn again in the shell of the settings: a card « Identity », with a row for the logo, the name and the address of the workspace, and « Save » in the head of the page, disabled until the name changes. The deletion of the workspace moves to a « Danger zone » with a red border, for the owner alone: « Delete… » opens a dialog that deletes only once the name of the workspace is typed in it.
- fe7ce0c: Members is one dense table: a line of 36 px per person with their address, their role, their sites, the day they were last active and the day they joined, and « … » to remove them. An owner or an admin changes a role in its row; a guest made a member asks twice, as they then read every site. The invitations that wait are a tab of their own, with their counts and the search. « Invite people » takes several addresses at once, offers the role as three cards that say what each one does, and « Send N invites » counts the valid addresses.
- b1e134f: A note opens in a panel of 440 px beside the list, which stays in view with its row marked: the reference and the issue in its head, the arrows to the note above and under it, the fields as lines, the page in a picture with « Open on the page », the replies, and « Technical details » folded at the end. Escape closes it and gives the focus back to the row. The copies of a note are in the menu of its head.
- 4175c80: The Notes list is one line of 36 px per note, as dense as Linear: fourteen notes show at 1440 × 900 where six did. Each status is a group whose head folds it, which the console remembers for each person, and « + » there writes a new task in that status. A line holds the status, the text at 500 on one line, the path of the page, the site, where the note went (« Failed » in red with a button that sends it again), who left it (a dashed round for a visitor) and its age. A narrow list drops the columns that have no room, in place of the cards. The keys j and k move between the notes, and Enter opens one.
- df4d750: The Notes screen has the head and the bar of Linear: « Notes » and a tab per place the notes went, with its mark and its count; then « Filter », a menu by field whose filters show as chips with a cross and « Clear », the count of the notes, a search of 220 px that « / » reaches, and « Display », which shows the table or the board.
- 085370d: My account and the settings of the workspace share one shell: a bar that says « Settings », a navigation of 220 px with an icon on each entry, in two groups (Account: Profile, Sessions; Workspace: General, AI, Agents, Members, Connectors), and the page beside it. My account is the page « Profile »: four cards in two columns from 1280 px, one column under it. The profile, the last three browsers where you are signed in (« See all » opens the new page « Sessions »), the addresses and how you sign in. Each row of a card has an icon. The rare actions are in the menu of a row or in a dialog: « Make primary » and « Remove » of an address, « Disconnect » of a browser, « Add » an address, « Sign out everywhere ». « Sign out » is the action of the head of the profile. The addresses of the pages do not change.
- d1a1744: The Sites screen is a dense table, one line of 36 px per site: the site and a link to it, its notes by status and how many, its new notes in red, where they go with the logos of the trackers (and the icon of a retry in red when an address did not take some), who sees them, the last note and the menu. A press on a row opens the page of its site. « Sites » and « Add a site » are in a head of 48 px, and the bar under it holds the search by address, which « / » reaches, and the colours of the statuses. A band under the table names the sites that keep their notes in Fruitback, with « Connect a tracker ». The columns go by the width of the table: at 390 px a row keeps the site, its new notes and its menu.
- 6b445b9: The console takes the slate theme of the redesign: slate greys on a white page, one radius of 6 px for every control (8 px for a card, 10 px for a modal), three heights of a control (24, 28 and 32 px), and Inter at 13 px, served by the console. Each token is a CSS variable, so a setting of the appearance can change it at once. The extension, the widget and the docs do not change.
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
- aac382a: « Connectors » lists two recipes that start an agent with no code, under « Your connectors », each once its tracker is connected: an agent of Linear, to which the Linear issue of a note is delegated, and Claude Code in GitHub Actions, on the GitHub issue of a note. Each card leads to its steps in the guide; neither takes a field or a secret.
- f7d4236: The administrator of a self-hosted instance reads a banner when a newer release is out, and can dismiss it. The worker answers it on `GET /console/admin/release`. The upgrade guide says what a pull takes for each kind of image tag.
- 8f235e8: The setup takes the address of a visit: `/setup?site=staging.acme.dev`, as the landing will send it, names the site from the first screen and shows it in the preview, then adds it as soon as the person is signed in, with no field and no « Add site ». Only a workspace with no site gets it, seen by its members only. Google and GitHub now come before the e-mail link in the first step.
- 1fd6959: The sidebar has a « Views » section under its sections: « Assigned to me » opens the notes with the filter `assignee=me` in the address, and is the entry on screen while the notes show that filter alone. Its count is the total the notes screen last read for that filter: the sidebar asks the worker nothing more. « New this week » and « Not delivered » of the mockup wait for filters of the worker (FRU-722), and a guest has no view.
- 6cfe11e: The page of a site has a tab « Access »: who reads the notes and who leaves them, as four levels (Closed, Read only, Contribute, and Collaborate to come), and a table of what a visitor may do. A visitor's right to change the text of their own note and to take it back is a setting of each site, `never` or `while-open`, kept by the worker in two new columns. « Who can leave a note » now decides on a site that everyone reads too: « Read only » is read by anyone and written by its members. The migration gives every site that everyone read « Anyone on the page », and every site of before `never` for both rights, so no site changes.
- 7cbded3: The page of a site is in tabs: Overview, Install, Destinations, Statuses, Access and Advanced, each at an address of its own, under a head with « Open site » and « See its N notes ». « Overview » shows three figures (the notes and their statuses, the new ones, the share delivered), the settings of the site in rows with « Change », where its notes go with the logo of each tracker and a menu, and a card « Install » on the right with the script on a dark block and « Copy ». The card says « Not seen yet » until a note comes through the script or the extension: the worker records no visit of the script yet. A link to a section of the page of before opens its tab.
- 25734d3: A workspace can post its notes in a Slack channel, by an Incoming Webhook. Each verified note, or each note if the connector says so, is posted with its link, its element and its capture, while the notes stay in Fruitback. The webhook is kept encrypted, and the panel of the connector lists the notes that did not reach Slack.
- d6cae1c: Several tasks that Fruitback keeps can be selected at once, by their boxes, with Shift and a click for a range, or with Cmd or Ctrl and A for the page. A bar under the list changes their status, assignee, priority, labels or due day, archives them or deletes them, in one call that changes all of them or none; the menu of a selected task acts on the whole selection.
- 687ed1f: A task is copied as its link, its ID or Markdown for an agent, from its menu, its panel, Cmd/Ctrl+Shift+C and Cmd/Ctrl+Shift+. The tool `notes_as_text` of a whole site ends with its tasks written by hand.
- 01b7b9b: A task is written by hand in the console, with a title and, if you like, a text, a status and its fields. It has no page and no pin.
- 2e93317: An address that receives the notes of a site is told of each change of their tasks: `note.status_changed` with the status before and after, `note.replied` with the id of the reply, and `note.updated` with the names of the fields that changed (assignee, priority, labels, day). Each holds ids and names only, is signed and tried again as a note, and a change that changes nothing sends nothing. A note sent to an address now takes replies, kept in Fruitback. The console names these events in the deliveries that did not arrive.
- 36dbf5c: A task that Fruitback keeps has an assignee, a priority, a day and labels. The list and the board of the notes show them.
- 9390cc2: The list of the notes filters the tasks Fruitback keeps by assignee, priority, label and due day.
- d37baa0: A task that Fruitback keeps has a menu, on its button or a right click: its status, its assignee, its priority, its day and its labels, and a new label.
- 5a3f29a: A task that Fruitback keeps can be put in its place in its column of the board, archived, brought back and deleted.
- 4f057d0: A note opens in a panel over the list: its text, its page, its element, its replies, and the fields of its task.
- d96c822: The author of an open note can withdraw it from « ⋯ » in its thread. The thread asks first, then closes the note, and nothing is deleted. A reply under the note says who withdrew it. On Linear, the issue gets the same reply as a comment and moves to the team's first canceled state. An address receives a new `note.withdrawn` event, which carries identifiers only, and the console lists it with the other deliveries. The read gives `withdrawable: true` for the note the reader may withdraw. Notes sent to GitHub cannot be withdrawn.

### Patch Changes

- a5b01d9: The notes of the instance: « Previous » from the last page says the range of the page before again, as « 4 to 6 of 7 », and no longer a range counted from the notes of the last page, as « 6 to 8 of 7 ».
- a4df6fc: The banners on ink (« Fruitback cannot reach its server » and « Your session ended ») draw their controls on the ink: no fill, white words and a white border, tinted under the pointer. « Try again » and « Continue » were white buttons of a page, and « Sign in » is now as tall as « Continue » beside it.
- b7ecbff: « Add a site », in the head of the Sites screen, opens with a plus, as the mockup draws it.
- 58f1b29: The controls of the console kit (buttons, links, fields, lists, boxes, switches, filters, menus, tooltips, the drawer and the alert) take their styles as Tailwind classes, and their rules leave `app.css`. Nothing changes on screen.
- dc94a2c: The rest of the console kit (drops, status bars, tables, panels, titles, steps, frames and the selection of tasks) takes its styles as Tailwind classes, and its rules leave `app.css`. Nothing changes on screen.
- 810b71a: The screens of the console (the rail and its moves, the preview of a site, the setup, the dialog that adds a site, the panel of a connector) and the example page of the setup take their styles as Tailwind classes. `app.css` keeps the imports of HeroUI, its theme, the rules of every element, the view transitions and the keyframes. Nothing changes on screen.
- 753b8c2: The menu that changes the workspace shows each workspace's tile before its name: its logo, or its initial, as the name in the bar does.
- c200469: An invitation sent from Members now links the short guide of a client, « How to leave a note » (fruitback.com/leave-a-note.html).
- c40459d: Linear keeps one pair of tokens for each Linear workspace, and a new consent ends the pair of before. A Linear connected in a second Fruitback workspace therefore ended the first one. Now every Linear connector of the same Linear workspace shares the pair. A consent or a refresh brings them all back, and disconnecting one connector revokes the pair only when no other connector uses it.

  A connection that Linear ended is reconnected in place: « Reconnect Linear » in the panel of the connector keeps its sites, their places and its settings. A « Connect » for a Linear workspace that the workspace already holds brings the old connector back instead of making a second one. The extension says, under « Sent to », that the notes of the site do not reach a tracker that refuses the connection. For an owner or an admin, it opens that connector in the console.

- 1c3d94c: In the console, each press of « Next page » counts, even when it comes while the next page is read: it goes on from the page asked last, not from the page on the screen. Two quick presses now go two pages on instead of one, and « Previous page » takes back a press that waits. The notes of a workspace and the notes of the instance both read their pages this way. Nothing changes on the screen: no button is turned off while a page is read.
- 74ea4bd: The notes of a workspace: when the connectors do not load, the screen says so above the list, with « Try again », and the tabs of the places no longer call each connector « A connector that was removed ». The filters « Assignee » and « Label » say when the members or the labels did not load, with « Try again », instead of offering only « Any … ».
- 0ffcef2: The Tailwind theme of the console moves to `packages/shared/tailwind/theme.css`, which the extension, the widget and the docs import too. Nothing changes on screen: the built stylesheet is the same, byte for byte.
- 1f06cd8: The « Assignee » menu of a task lists the members of the workspace again, past a hundred of them too:
  the console asked for 200 members in one page, the worker took 100 at most and refused, and the menu
  listed nobody. The console now reads them a page of 100 at a time. A read that fails says so in the
  menu and on the page of the task, with « Try again ».
- 381f63b: The « Labels » menu of a task, and the page of a task, say when the labels of the workspace did not
  load, with « Try again »: the menu said « No label yet » to a member, or offered only « New label… » to
  an owner, and the page of a task drew no field « Labels », as if the workspace had none.
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
- 8d73e91: « Connect an agent »: the page of the console where an owner or an admin answers an app that connects to `/mcp` with OAuth, as a connector of claude.ai. It names the app by the host its answer goes to, and asks for the workspace, the sites, the rights (never more than asked), the days and « Only the notes of known people ». A connection is listed in « Agents » with the chip « OAuth · host », and revoked there.

### Patch Changes

- 172e083: The console loads its French words only for a person who reads French: the chunk that every page loads is 112 kB smaller (33 kB compressed), and a page shows sooner in English. A French browser waits for its words before the first screen, so it never shows English first.
- f29ee69: The console reads one site for the page of a site and its statuses, a page of 12 sites for the grid, and only the id and address of the sites for the lists that choose one: the notes of every site of the workspace are no longer counted on every screen.
- 86c5798: `@fruitback/shared` exports the messages between the console and the extension of the same browser: `EXTERNAL_VERSION`, `EXTERNAL_TYPES`, the types `ExternalAsk` and `ExternalAnswer`, the lists `EXTERNAL_CONNECT_STATES` and `EXTERNAL_REFUSALS`, and `parseExternalAnswer`. The console reads each answer of the extension through it in place of casts, and the extension answers with the same types. The messages themselves do not change.
- 1afc0f8: The page of a site says when GitHub lists only 1,000 of the repositories of an installation, and adds another one by its name. A read of the notes of a page keeps the search pages already read when GitHub refuses a later one for its rate.
- 4f6da7d: A Linear destination of a site carries the page of its team at Linear, `url` (`https://linear.app/<workspace>/team/<KEY>/all`), built by the worker from the keys Linear answers when the places of a site are written: the read of the places asks Linear for the `urlKey` of its workspace and the `key` of each team, in the same call as before. Migration 0041 adds the column `url` to `site_destinations`. A destination written before has none until its places are written again. On the Sites screen, the team under « Linear » is a link to that page, in a new tab.
- 9e5c5d8: The notes of a workspace and the notes of the instance count their filter once: « Next » and « Previous » keep the counts of the first page, and the worker reads the page alone (`counts=none`). The notes of the whole instance are read from a new index, `note_index_by_instance_date` (migration 0040): a page took 31 ms on 190,000 notes, it takes 0.08 ms.
- 9b7ed99: `@fruitback/shared` exports how a note is painted and named, and the core of the words of the console and the extension, written once: `STATUS_INK`, `paintOfStatus(color, textColor)`, `statusLabel(statusName, stateName, stageWord)`, `nearestLanguage(tag, languages, fallback)` and `fillSentence(sentence, values)`. The widget, the extension, the console and the worker use them in place of their own copies; what each draws and says does not change.
- 13f548a: The page of a site drops a read of its connectors that a newer read, or the page leaving, replaced. A spec holds what the build does: one read of the connectors, and of the teams and repositories of each, when the page opens; and a list that answers after the page left is dropped and read again on its return.
- Updated dependencies [86c5798]
- Updated dependencies [e0e3ad1]
- Updated dependencies [e3fea3b]
- Updated dependencies [9b7ed99]
  - @fruitback/shared@0.7.0

## 0.6.0

### Patch Changes

- @fruitback/shared@0.6.0

## 0.5.0

### Minor Changes

- ed49f59: A site can start an agent of the team when a note arrives: off by default, an owner or an admin turns it on in the page of the site. It calls an address of the workspace that receives (the REST connector), signed and tried again, when a note of a known person arrives or when a person of the team moves a note to To do. The call, `agent.requested`, carries the ids of the note, never its text; the agent reads the note through `/mcp` with its key.
- f65c131: The settings of a workspace lead to « Agents », where an owner or an admin makes an agent key (shown once, with the line that connects Claude Code), lists the keys with their last use and their end, sees what each one wrote, and revokes one.
- 91e55ad: On Fruitback Cloud, step 3 of the setup connects the extension of the same browser in place: one click, no `/connect` tab, no word to compare. The Chrome and Edge build declares `externally_connectable` for `https://app.fruitback.com` alone, and answers three strict messages from the top frame of a tab of that origin; no secret crosses that channel. Firefox, Safari and a self-hosted console keep the sign-in with the word.
- ff0f0d1: On Fruitback Cloud, step 3 of the setup folds the guide of the extension under its two cards: five steps, in English and in French, each with its capture and the version of the extension that took it. A click on a capture opens it whole.

### Patch Changes

- Updated dependencies [106f528]
- Updated dependencies [ec76366]
- Updated dependencies [5e1e3a0]
  - @fruitback/shared@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [504d911]
- Updated dependencies [54fc764]
  - @fruitback/shared@0.4.0
