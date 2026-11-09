---
'@fruitback/worker': minor
'@fruitback/widget': minor
'@fruitback/console': minor
---

The author of a note can edit its text while the note is open: new, to do or in progress, and no longer only while it is new. On a note sent to Linear, Fruitback leaves the description of the issue as it is and posts a comment « Edited the note » with the new text, and the thread shows that new text. An address receives a new `note.edited` event, which carries identifiers only, and the console lists it among the deliveries. Notes sent to GitHub, and sites whose replies are hidden, still take no edit.
