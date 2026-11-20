---
'@fruitback/widget': minor
---

The widget runs with no worker: `init({ notes })` hands each note to `write`, and draws the pins that `read` gives back. `localNotes()` keeps the notes in `localStorage`, for a demo, a test or a page with no server. With `notes`, `endpoint` and `clientId` are optional, and the widget offers no reply, no place, no address to ask and no file.
