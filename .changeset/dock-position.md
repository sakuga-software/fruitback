---
'@fruitback/widget': minor
---

`init` takes `position`, the corner of the window the dock stands in: `bottom-right` (the default), `bottom-left`, `top-right` or `top-left`. The settings open from that corner. A script tag says it with `data-fruitback-position`. The handle gains `moveDock(position)`, which moves the dock without building the widget again, so a note being written stays. With no `position`, the dock stays where it was, at the bottom on the side where lines end.
