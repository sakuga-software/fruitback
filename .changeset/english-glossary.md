---
'@fruitback/widget': minor
---

The English of the widget says « note », as its French does: the button is « Leave a note » (was « Leave feedback »), the widget is named « Fruitback notes », the field of a note is « Your note », the settings say « Statuses shown », « Hide resolved notes » and « Copy the notes as text », and the copied text starts with « Notes on {url} ». A host that overrides these keys through `init({ messages })` keeps its own words; a test or a script that finds the button by « Leave feedback » needs the new name.
