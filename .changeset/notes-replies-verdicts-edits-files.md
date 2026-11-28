---
'@fruitback/widget': minor
---

`notes` takes five more functions, each optional: `reply(id, { text, author? })`, `check(id, { verdict, text?, author? })`, `edit(id, text)`, `withdraw(id)` and `attach(file)`. The widget offers the field to reply, « Looks fixed » / « Still wrong », « Edit the note », « Withdraw the note » and the files of the composer only where `notes` has the function. `write` gets the ids `attach` gave as its second argument, `{ attachments }`. `read` may give back `mine`, `replies` and `attachments` with each note: `mine` is what offers the edit, the withdrawal and the verdict to the author. `localNotes()` takes them all: every note it keeps is the reader's, and of a file it keeps the name only. A widget with `notes` never offers to move a note.
