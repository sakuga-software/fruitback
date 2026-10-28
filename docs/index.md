---
layout: landing
---

<!--
  The page around these guides is docs/_layouts/landing.html (FRU-309, FRU-387): the hero, how it
  works, the product, who it is for, the connectors, the two offers and the questions. This file keeps
  the guides, so that every one of them is linked from the home page (docs-site.test.ts).
-->

## The guides

|                                           |                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Choose a mode](modes.md)                 | Public, private and team: what the site ships in each, and who may read the pins. Start here.      |
| [Install the widget](install.md)          | Two lines on a site with no build step, and what each option does.                                 |
| [Run Fruitback yourself](self-hosting.md) | From an empty folder to a first pin, then backups, upgrades and every environment variable.        |
| [Review with the extension](reviewing.md) | The reviewer's side: the browser extension, a rule per site, and pairing.                          |
| [Translate the widget](translating.md)    | The words a host can replace, and the catalogs the bundle carries.                                 |
| [REST connector](rest-connector.md)       | The request the Cloud posts for each note, its signature, and what happens when you do not answer. |
| [Connect an AI agent](agents.md)          | Claude Code or a cloud agent reads, replies and sets a status with a key, and what it cannot stop. |
| [What the widget collects](privacy.md)    | Every field a note carries, where it goes, how long it stays, and how to delete it.                |
| [Architecture](architecture.md)           | What the parts are, and the designs that were dropped.                                             |

## The code

The source is on [GitHub](https://github.com/sakuga-software/fruitback), under the MIT licence for
the five published packages and AGPL-3.0-only for the worker, the console and the browser extension. The
[decisions](https://github.com/sakuga-software/fruitback/tree/main/docs/decisions) folder holds the
per-ticket histories: the measurements, the first versions that failed, and the reviews that caught
them.
