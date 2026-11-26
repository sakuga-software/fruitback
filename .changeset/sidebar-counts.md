---
'@fruitback/worker': minor
'@fruitback/console': minor
---

The bar of the console shows its counts as soon as a workspace opens: the open notes beside « Notes », the sites beside « Sites », the sends that did not arrive in red beside « Connectors », and the tasks of the person beside « Assigned to me ». One read gives them, `GET /console/workspaces/<id>/rail`, when the workspace opens and at each change of workspace. A guest counts the sites shared with them and their notes, and never the sends of the connectors.
