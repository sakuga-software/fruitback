---
'@fruitback/worker': minor
'@fruitback/console': minor
---

`/mcp` reads and changes the tasks Fruitback keeps. `list_notes` and `get_note` give the fields of a
task, and `list_notes` filters by assignee, priority, label and due day, as the console does. The new
`task_choices` gives the ids of the labels and of the members, and `update_task` changes the status,
the assignee, the priority, the due day and the labels, for a key that writes. On a worker that keeps
no task, no tool of a task is listed. The log of a key in the console says « Changed the fields of a
task ».
