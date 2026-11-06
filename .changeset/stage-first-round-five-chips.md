---
'@fruitback/widget': minor
'@fruitback/shared': minor
'@fruitback/extension': minor
---

A note in the list says the stage of Fruitback first and the tracker second, « In progress · Linear: In Review », after a round that fills as the note moves on: a dashed ring for New, an empty one for To do, half full for In progress, full with a tick for Done, with a cross for Closed (`createStageRing`). The filter of the list keeps its shape: All and the five stages, Closed too, in the widget and the side panel; the list of statuses that took the place of the chips beyond five statuses is gone, and the search finds the name of a status or the word of a tracker. `trackerOf`, `stageFirstLabel` and `TRACKER_NAMES` of `@fruitback/shared` name the tracker of an issue by its address.
