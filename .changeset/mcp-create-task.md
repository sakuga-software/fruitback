---
'@fruitback/worker': minor
'@fruitback/console': minor
---

`/mcp` writes a task with no page and no pin. The new `create_task`, for a key that writes, takes a
title and, if you like, a text, a status, an assignee, a priority, a due day and labels, as « New
task » of the console does. It refuses an argument it does not take, a site that is not of the key,
and a status, a member or a label that is not of the site or of the workspace, and then writes
nothing. Its answer says what it wrote. `update_task` and `set_note_status` now change such a task
too. A task an agent writes starts no agent. In the console, the log of a key says « Wrote a task ».
