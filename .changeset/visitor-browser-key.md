---
'@fruitback/worker': minor
'@fruitback/widget': minor
---

A visitor with no account sees « You · this browser » on the notes they left from this browser. At the first note, the widget makes a random key for the site and keeps it in the page's `localStorage`. It sends the key in the `X-Fruitback-Visitor` header, and the worker keeps only a SHA-256 digest of it with the note. A read that sends the same key gets `mine: true` on those notes. Another browser, a missing key, or a key of another shape gets nothing. The key is not a proof of identity, and it does not let a visitor edit or withdraw a note yet. Nothing changes for a member, and a widget mounted with an identity token or by the extension makes no key. Migration `0050_note_index_author_visitor` adds the column `note_index.author_visitor`. Every row of before keeps an empty value.
