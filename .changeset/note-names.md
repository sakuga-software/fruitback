---
'fruitback': minor
'@fruitback/shared': minor
'@fruitback/widget': minor
'@fruitback/element': minor
'@fruitback/react': minor
---

A note is no longer called a « seed » in the contract (FRU-378). `@fruitback/shared` exports `Note`, `noteSchema`, `createNote`, `parseNote`, `parseNoteFromDescription`, `NOTE_STAGES` and the other new names, and `@fruitback/shared/note.fixture`. The names of before still work, marked deprecated: `parseSeed` and `parseSeedFromDescription` answer `{ ok: true, seed }` as they did, where the new parsers answer `{ ok: true, note }`. The parsers also read a note of the kind `fruitback.note`, version 3, whose words are in `text`; a note is still written as `fruitback.seed`, version 2.
