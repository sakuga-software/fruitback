---
'@fruitback/console': patch
---

The panel of a note takes Escape and the focus from the moment it is drawn: on a slow computer, an Escape pressed as it opened closed nothing. `/connect` keeps its pace of one read every ten seconds when the worker answers slowly: a turn that came while a read was on its way was lost, and the page could stop asking.
