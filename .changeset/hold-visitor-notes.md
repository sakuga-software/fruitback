---
'@fruitback/worker': minor
'@fruitback/console': minor
'@fruitback/widget': minor
---

A site can hold the notes of its visitors for a member: « Hold new visitor notes », the second line of the card « Safeguards » in its tab « Access », off by default. A note sent with no account then waits in the database, `POST /feedback` answers `202` with `held: true`, and the widget says « Sent for review » with no pin. A member finds the notes in « To approve », a new entry of the views in the bar, and approves one (it goes to its place, as the visitor's own) or rejects it. A note waits 30 days at most.
