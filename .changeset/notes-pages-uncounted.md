---
'@fruitback/worker': patch
'@fruitback/console': patch
---

The notes of a workspace and the notes of the instance count their filter once: « Next » and « Previous » keep the counts of the first page, and the worker reads the page alone (`counts=none`). The notes of the whole instance are read from a new index, `note_index_by_instance_date` (migration 0040): a page took 31 ms on 190,000 notes, it takes 0.08 ms.
