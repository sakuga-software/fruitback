---
'@fruitback/shared': minor
'@fruitback/widget': patch
---

`@fruitback/shared` exports `RESOLVED_STAGES`, the stages done and closed. The widget's `RESOLVED_STAGES` is now that same list, re-exported, and stays a public export. The console reads it for its « Unresolved » filter of the status.
