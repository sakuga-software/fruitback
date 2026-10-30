---
'@fruitback/widget': patch
---

The widget keeps its styles on a page whose Content Security Policy refuses inline styles (`style-src 'self'`): each part adopts its stylesheet into the Shadow root in place of a `<style>` element, which such a page refused. There, the widget showed the browser's own buttons.
