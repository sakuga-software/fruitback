---
'@fruitback/worker': minor
'@fruitback/console': patch
---

A Linear destination of a site carries the page of its team at Linear, `url` (`https://linear.app/<workspace>/team/<KEY>/all`), built by the worker from the keys Linear answers when the places of a site are written: the read of the places asks Linear for the `urlKey` of its workspace and the `key` of each team, in the same call as before. Migration 0041 adds the column `url` to `site_destinations`. A destination written before has none until its places are written again. On the Sites screen, the team under « Linear » is a link to that page, in a new tab.
