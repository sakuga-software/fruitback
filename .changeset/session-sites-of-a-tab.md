---
'@fruitback/worker': patch
'@fruitback/extension': patch
---

The popup asks the worker for the sites of its tab only (`GET /session/sites?origin=…`), and for the language of the account through the list of the worker's own origin: it no longer reads every site of every workspace, with their counts, at each open. The worker reads the workspaces of an account four at a time, and counts the notes only of a workspace that has a site of the tab. Without the parameter, the answer is the whole list, as before, for the extensions already installed.
