---
'@fruitback/worker': minor
'@fruitback/widget': minor
'@fruitback/extension': minor
---

The person who left a note gets one e-mail when the team marks it done: a member at the address of their account, a visitor at the address they gave just after the note, once per browser. The worker keeps that address for one message, 90 days at most (table `done_notices`, migration `0042`), and takes it on `POST /feedback/<note>/notify` with the token of the note. The icon of the extension shows, for the site of the tab, how many notes of the reviewer are done and waiting for their check.
