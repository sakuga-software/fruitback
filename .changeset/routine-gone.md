---
'@fruitback/worker': minor
'@fruitback/console': minor
---

A Claude Code routine whose `/fire` answers `404` (the routine or its API trigger was deleted) now needs attention, as `routine-gone`: the call is given up, the Connectors screen says « Needs attention » on its row, its panel says that claude.ai says the routine is gone and how to connect one again, and the box « Start an agent » of a site that calls it says why its calls stopped. The next call that starts the routine ends the attention.
