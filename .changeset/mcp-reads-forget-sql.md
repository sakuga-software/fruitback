---
'@fruitback/worker': patch
---

The read tools of `/mcp` read the pages of their notes 4 at a time, not one after the other, and answer the same. `forget` of the PostgreSQL store leaves out in SQL the rows that cannot be the notes asked for, and reads and deletes the rows 500 at a time.
