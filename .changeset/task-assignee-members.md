---
'@fruitback/console': patch
---

The « Assignee » menu of a task lists the members of the workspace again, past a hundred of them too:
the console asked for 200 members in one page, the worker took 100 at most and refused, and the menu
listed nobody. The console now reads them a page of 100 at a time. A read that fails says so in the
menu and on the page of the task, with « Try again ».
