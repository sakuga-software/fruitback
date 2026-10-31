---
'@fruitback/console': patch
---

The console loads its French words only for a person who reads French: the chunk that every page loads is 112 kB smaller (33 kB compressed), and a page shows sooner in English. A French browser waits for its words before the first screen, so it never shows English first.
