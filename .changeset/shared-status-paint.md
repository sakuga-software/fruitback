---
'@fruitback/shared': minor
'@fruitback/widget': patch
'@fruitback/extension': patch
'@fruitback/console': patch
'@fruitback/worker': patch
---

`@fruitback/shared` exports how a note is painted and named, and the core of the words of the console and the extension, written once: `STATUS_INK`, `paintOfStatus(color, textColor)`, `statusLabel(statusName, stateName, stageWord)`, `nearestLanguage(tag, languages, fallback)` and `fillSentence(sentence, values)`. The widget, the extension, the console and the worker use them in place of their own copies; what each draws and says does not change.
