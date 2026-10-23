---
'@fruitback/widget': patch
---

The composer is built element by element instead of from an HTML string given to `innerHTML`. Nothing changes on screen. A page whose Content Security Policy requires Trusted Types no longer refuses it, and the validator of addons.mozilla.org no longer flags it.
