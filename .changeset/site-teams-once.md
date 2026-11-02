---
'@fruitback/console': patch
---

The page of a site reads its connectors once, and the teams of each Linear and the repositories of each GitHub once, also under the `StrictMode` of development, which ran these reads twice: 2 × 51 calls to Linear for 300 teams.
