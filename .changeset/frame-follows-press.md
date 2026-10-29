---
'@fruitback/widget': patch
---

The frame of a capture and the composer stay on an element that is smaller while it is pressed, such as a button drawn at `scale(0.97)` under `[data-pressed]`. They were placed on the pressed box and stayed about 1 px off once the button was released. They now follow the box of the element for the few frames after the choice, until it stays the same (200 ms, at most 1 s). In a right-to-left language the composer keeps to the right edge of its element.
