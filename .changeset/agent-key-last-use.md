---
'@fruitback/worker': minor
---

The worker keeps when each agent key last opened a request of `/mcp`, to the minute, and the list of the keys in the console API answers it as `lastUsedAt` (`null` for a key nobody used).
