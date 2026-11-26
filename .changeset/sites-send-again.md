---
'@fruitback/worker': minor
'@fruitback/console': minor
---

Sends again, in one press, the notes of a site that did not arrive (FRU-717). On the Sites screen, the red arrow of the column « Sent to » is a button for an owner or an admin: `POST /console/workspaces/<id>/sites/<site>/retry` makes the deliveries of its notes due now, 100 at most, and answers how many leave and how many are left. The loop of the worker sends them, so a second press sends nothing twice. A member keeps the link to the notes of the site.
