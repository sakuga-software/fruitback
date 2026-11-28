---
'@fruitback/worker': minor
'@fruitback/console': minor
'@fruitback/widget': minor
---

A site can recognise its visitors by a token its backend signs: « Signed by your site », in the card « How a visitor is recognised » of its tab « Access ». An owner or an admin makes the key of the site there, shown once and kept sealed with `FRUITBACK_SECRETS_KEY`; the backend signs a short HS256 token (`sub`, `exp`, and optionally `name` and `email`), and the widget sends it with `init({ identityToken })`. The notes of that person are theirs on every device, with the rights of a visitor: they edit and delete them while they are open, and the safeguards of the site count them. A token that expired, that another key signed, or that a site sends after it stopped signing falls back on the key of the browser, which the widget now keeps beside the token, with no right more. The read says `visitor: 'signed'`, and the widget shows « You » on such a note.
