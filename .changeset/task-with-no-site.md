---
'@fruitback/worker': minor
'@fruitback/console': minor
---

A task written by hand may have no site: it belongs to the whole workspace. In the console, « New
task » offers « No site: the whole workspace » to a member, and a workspace with no site yet can
write tasks too. Such a task takes the built-in statuses, and every field of a task. Every member
reads and changes it as a task of a site; a guest neither sees nor writes one, and an agent key, which
reads the sites it names, does not read it. It stays when a site is removed, and goes with its
workspace. `POST /console/workspaces/<id>/notes` takes no `site` for it.
