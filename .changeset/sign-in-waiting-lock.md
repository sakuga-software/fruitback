---
'@fruitback/console': patch
---

The tab of a sign-in link waits for the tab that asked for it when that tab holds a Web Lock, so a
busy browser that delivers « signed-in » late still lets the setup carry on, and the tab of the link
says « You are signed in ».
