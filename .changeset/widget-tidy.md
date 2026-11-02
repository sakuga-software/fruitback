---
'@fruitback/widget': patch
---

Internal tidy of the widget, with no change to what it shows or does: the CSS of each part moves to its own `*.styles.ts`, the calls to the worker go through one `worker-client.ts`, and the excerpt of a note, the date of a row and the failures of a write are written once. `init`, its options and the exported names do not change.
