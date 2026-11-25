---
'@fruitback/worker': minor
'@fruitback/widget': minor
---

A visitor with no account deletes their own note while it is open, from the same browser, after a confirmation. The widget menu reads « Delete the note », in red. The question is « Delete your note? », and it says that the pin goes away for everyone and that the issue in the tracker is closed as withdrawn. `POST /feedback/<id>/withdraw` takes the key of the browser on a site that takes notes from anybody, with the checks of a member's withdrawal. Nothing is deleted in the store: the note is closed with a reply, Linear cancels the issue, and an address gets `note.withdrawn`. The index marks the row (`note_index.removed_at`, migration `0051_note_index_removed_at`), and a read of the page no longer shows that note to anybody. The team keeps the note, closed, in its tracker and in the console. A member's withdrawal is unchanged.
