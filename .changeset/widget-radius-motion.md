---
'@fruitback/widget': patch
---

The buttons and the tags of the widget are no longer pills: « Send », « Cancel », « Send reply », « Leave a note » in the list, the chips of the statuses and « Guest » take corners in proportion to their height. « DEV-001 → » and « Choose another element » get back the corner that their transparent border took.

The widget moves faster: 150 ms for a fade or a press, 240 ms for the composer and the drop of a pin. Every button eases its colours and gives way a little under a press, and the menus « Attachments » and « More » fade in. With `prefers-reduced-motion`, none of it moves.
