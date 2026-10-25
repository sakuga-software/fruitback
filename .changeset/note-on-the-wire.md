---
'@fruitback/shared': minor
'@fruitback/worker': minor
---

The protocol says `note` next to `seed` (FRU-378). `toNoteV3` gives a note in the shape of `fruitback.note` v3, and `parseNote` reads it back as the same note. Each issue of `GET /feedback` and each REST delivery carries the note in `note` in that shape, next to `seed`, unchanged. `GET /session/notes` gives the id of each note in `note` and in `seed`. `POST /feedback` refuses a note with the code `invalid-note` instead of `invalid-seed`. The commands take `forget --note` and `migrate-to-postgres --notes`; `--seed` and `--seeds` stay as their aliases.
