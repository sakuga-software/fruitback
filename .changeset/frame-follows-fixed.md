---
'@fruitback/widget': patch
---

The frame of a capture and the composer stay on an element that does not scroll with the page, such as a link of a fixed sidebar, instead of scrolling away from it. `Composer.open` also takes the element itself, and then follows it.
