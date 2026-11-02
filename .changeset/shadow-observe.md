---
'@fruitback/widget': patch
---

A pin on an element inside a web component finds its element when the component draws its content after the widget placed the pins. The widget observes the open shadow roots that the `hosts` of the notes on the page go through, and waits for a custom element that is not defined yet. Before, the pin stayed an orphan until the document changed or the window resized. A note without `hosts` is resolved as before.
