---
'@fruitback/shared': minor
'@fruitback/worker': minor
'@fruitback/widget': minor
'@fruitback/extension': minor
---

A member changes the status of a note from the head of its thread: the chip of the status becomes a button with a chevron, and its menu lists the five stages, the one of the note checked. The widget sends the built-in status of the stage through `POST /feedback/<id>/status`, the route the console and the extension already had, with its rights: the person who left the note or a role that manages the sites, with a session. The read says `canSetStatus` on each note the reader may move, after the cache. A visitor, a guest with no right on the note and a note of a tracker keep the status read only. The extension relays `/feedback/<id>/status` with the session.
