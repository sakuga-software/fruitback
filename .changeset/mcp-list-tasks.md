---
'@fruitback/worker': minor
---

`list_notes` of `/mcp` lists the tasks written by hand with the notes of the site, newest first, and
its filters (assignee, priority, label, due day, archived, status, stage, words) take them. Each
entry now says what it is in `kind`: `note` for a note of a page, as before, or `task` for a task
written by hand, in the shape `get_note` gives it (what was written in `task`, its fields in
`fields`). `get_note` gives `kind` too. The version of the tools is `4`.
