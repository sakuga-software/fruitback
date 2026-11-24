---
'@fruitback/worker': minor
'@fruitback/console': minor
---

An address that receives the notes of a site is told of each change of their tasks: `note.status_changed` with the status before and after, `note.replied` with the id of the reply, and `note.updated` with the names of the fields that changed (assignee, priority, labels, day). Each holds ids and names only, is signed and tried again as a note, and a change that changes nothing sends nothing. A note sent to an address now takes replies, kept in Fruitback. The console names these events in the deliveries that did not arrive.
