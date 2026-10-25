---
'@fruitback/worker': minor
---

`node server.mjs rewrite-notes` is removed, with the only reader of the notes written before 0.4.0 (FRU-449). A worker of before 0.4.0 upgrades to 0.4.0 first and runs `rewrite-notes` there, then takes a later version: `docs/self-hosting/upgrade.md`.
