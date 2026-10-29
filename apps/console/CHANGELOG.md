# @fruitback/console

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
