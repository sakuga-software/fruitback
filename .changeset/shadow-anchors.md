---
'@fruitback/shared': minor
'@fruitback/widget': minor
---

A note on an element inside a web component (an open shadow root) pins on that element again. The anchor carries an optional `hosts`: one selector for each shadow host between the document and the element, outermost first, and `selector`, `domPath`, `text` and `tag` are then read in the last shadow root. The widget writes it at capture and follows it when it places a pin; when a host is gone or its shadow root is closed, the pin falls back to its position and says so. `@fruitback/shared` exports `anchorSelectorPath`, which writes the hosts and the selector as one line (`#promo >>> button.buy`) in the issue description, the text of a page and the thread. A note without `hosts` reads and resolves as before, and `NOTE_VERSION` stays 3: a widget of before drops the field and places the pin as it did.
