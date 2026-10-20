---
layout: landing
---

<!--
  The page around these guides is docs/_layouts/landing.html (FRU-309): the hero, how it works, the
  modes, self-hosting, the extension and where it stands. This file keeps the guides, so that every
  one of them is linked from the home page (docs-site.test.ts).
-->

## The guides

|                                                          |                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [The three modes](modes.md)                              | Public, private and team: what the site ships in each, and who may read the pins. Start here.      |
| [Installing Fruitback](install.md)                       | Two lines on a site with no build step, and what each option does.                                 |
| [Running Fruitback yourself](self-hosting.md)            | From an empty folder to a first pin, then backups, upgrades and every environment variable.        |
| [Reviewing a site with the extension](reviewing.md)      | The reviewer's side: the browser extension, a rule per site, and pairing.                          |
| [Translating the widget](translating.md)                 | The words a host can replace, and the catalogs the bundle carries.                                 |
| [Receiving notes on your own address](rest-connector.md) | The request the Cloud posts for each note, its signature, and what happens when you do not answer. |
| [What the widget collects](privacy.md)                   | Every field a note carries, where it goes, how long it stays, and how to delete it.                |
| [Architecture](architecture.md)                          | What the parts are, and the designs that were dropped.                                             |

## The code

The source is on [GitHub](https://github.com/sakuga-software/fruitback), under the MIT licence for
the five published packages and AGPL-3.0-only for the worker and the browser extension. The
[decisions](https://github.com/sakuga-software/fruitback/tree/main/docs/decisions) folder holds the
per-ticket histories: the measurements, the first versions that failed, and the reviews that caught
them.
