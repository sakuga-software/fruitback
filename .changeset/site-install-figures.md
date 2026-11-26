---
'@fruitback/worker': minor
'@fruitback/console': minor
---

The page of a site says « Installed » once the widget was seen on it, with « Seen on the site 2 h ago », and its figures follow the mockup: « Open » says the age of the oldest open note, and « Delivered » the share of the notes of the last 30 days that arrived, with a link to the ones that did not. The worker writes when the widget last read a page of a site, by the script or by the extension, at most once an hour: one date per site and per way, in two new columns of `sites` (migration `0055_sites_seen`), and nothing else.
