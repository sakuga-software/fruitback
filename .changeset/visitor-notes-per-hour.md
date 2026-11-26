---
'@fruitback/worker': minor
'@fruitback/console': minor
'@fruitback/widget': minor
---

A site limits the notes a visitor with no account leaves in an hour: the line « Notes per visitor » of the new card « Safeguards » in its tab « Access », « No limit », 5, 10, 20 or 50, and 10 by default. The worker counts them by the key of the browser and by the address, on the site, before anything is written, and answers `429 visitor-limit` over it. The widget then says « Send it again later » and keeps the text. A member and a page that signs its reporter are not counted. The migration gives 10 to every site, those of before included.
