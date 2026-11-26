---
'@fruitback/worker': minor
'@fruitback/console': minor
---

A person saves the filters of the Notes screen as a view of their own. « Save view » in the bar of filters names the filters that are on, and the view shows in the bar under « New this week », « Assigned to me » and « Not delivered », where its menu renames it or deletes it. The worker keeps the views in a table of their own, beside the membership of the person, so a view follows its person from one browser to another, and nobody else reads it: `GET` and `POST /console/workspaces/<id>/views`, `POST` and `DELETE …/views/<view>`. A person keeps only filters they can read, and 20 views in a workspace at most.
