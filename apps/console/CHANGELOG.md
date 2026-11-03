# @fruitback/console

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
