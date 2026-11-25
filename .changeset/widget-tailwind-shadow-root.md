---
'@fruitback/widget': patch
---

The widget builds its styles with Tailwind 4, into a string adopted by its Shadow root, as before: nothing changes on screen. The area of a capture is the first part written in utilities (FRU-680). A page whose root says `font-size: 62.5%` leaves every size of the widget as it is.
