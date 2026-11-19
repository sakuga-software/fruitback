---
'@fruitback/worker': minor
'@fruitback/console': minor
'@fruitback/widget': minor
---

A note whose Linear place is gone now says why, everywhere. When Linear refuses a note with `INPUT_ERROR` and no longer finds the team or the project of the site, the worker writes Linear's reason to its log, keeps the state on the destination of the site, and answers `502 destination-unavailable` with a link to help. The console shows « Needs attention » on that destination and on the card of the site, with what to change. The widget keeps the text and says the team cannot receive the note: a member gets a link to the site in the console, anybody else a link to the guide « A note that did not go ». A widget of before still reads a `502` and keeps the note.
