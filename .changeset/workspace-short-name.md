---
'@fruitback/worker': minor
'@fruitback/console': minor
---

A workspace has a short name, and the console opens it at `/w/<short name>`: `acme` for « Acme ». An owner or an admin changes it in Settings › General, with the name; a name another workspace holds is refused, with its sentence. `/w/<id>` still opens the workspace, and so does a short name it left in the last 30 days: the console replaces either with the short name. `GET /console/me` answers `slug` and `formerSlugs` for each workspace, and `POST /console/workspaces/<id>` takes `slug` beside `name` (`400 invalid-slug`, `400 reserved-slug`, `409 slug-taken`). A migration gives every workspace the short name read in its name, and keeps the names a workspace left in a table of their own, 30 days each.
