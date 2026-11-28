---
'@fruitback/worker': minor
'@fruitback/console': minor
'@fruitback/widget': minor
---

A site can recognise its visitors by an address they confirm: « A confirmed e-mail », in the card « How a visitor is recognised » of its tab « Access », on a worker that sends e-mail. Before their first edit or deletion, the widget asks for an address under the note and the worker sends a link to the page, valid 30 minutes and once; opened in the browser that asked, it confirms the address, and the notes of that browser are the notes of the address. Another browser that confirms the same address finds them as its own. An address not confirmed gives no right, and the worker keeps digests only, never the address. The read says `confirm: 'email'` or `visitor: 'email'`.
