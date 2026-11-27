---
'@fruitback/worker': minor
---

A note sent to GitHub Issues now takes the replies, the verdicts, the edits, the moves and the withdrawals of a person, as a note sent to Linear does (FRU-628). Each one is a comment of the issue, written by the App. « Still wrong » reopens the issue. An edit or a move never writes the body of the issue again: a read takes the new text and place from the newest such comment written before the issue was closed. A withdrawal closes the issue as « not planned », and deletes nothing. The App needs no new permission: « Issues: Read and write » covers every call.
