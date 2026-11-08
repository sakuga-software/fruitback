---
'@fruitback/worker': minor
'@fruitback/widget': minor
'@fruitback/extension': minor
'@fruitback/console': minor
---

The author of an open note can move it to another element of the same page, from « ⋯ » in its thread. The widget asks for the new element, then the note moves there. On Linear, the issue keeps its description and gets a comment « Moved the note » that names the element, and the thread reads the note's new place from that comment. An address receives a new `note.moved` event, which carries identifiers only, and the console lists it with the other deliveries. Notes sent to GitHub cannot be moved.
